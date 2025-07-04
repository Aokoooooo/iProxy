var https = require('https');
var http = require('http');
var net = require('net');
var parseUrl = require('../util/parse-url-safe');
var mime = require('mime');
var extend = require('extend');
var util = require('../util');
var Transform = require('pipestream').Transform;
var h2 = require('../https/h2');
var rules = require('../rules');
var pluginMgr = require('../plugins');
var hparser = require('hparser');
var config = require('../config');

var WhistleTransform = util.WhistleTransform;
var SpeedTransform = util.SpeedTransform;
var ReplacePatternTransform = util.ReplacePatternTransform;
var ReplaceStringTransform = util.ReplaceStringTransform;
var FileWriterTransform = util.FileWriterTransform;
var formatHeaders = hparser.formatHeaders;
var getRawHeaderNames = hparser.getRawHeaderNames;

var TIMEOUT = config.timeout < 16000 && config.timeout > 0 ? 0 : 16000;
var LOCALHOST = '127.0.0.1';
var CRLF = util.toBuffer('\r\n');
var MAX_RES_SIZE = 1024 * 1024;
var JSON_RE = /{[\w\W]*}|\[[\w\W]*\]/;
var LIKE_JSON_RE = /^\s*[\{\[]/;
var X_RE = /^x/;
var BODY_PROTOCOLS = [
  'attachment',
  'resReplace',
  'resBody',
  'resPrepend',
  'resAppend',
  'htmlBody',
  'htmlPrepend',
  'htmlAppend',
  'jsBody',
  'jsPrepend',
  'jsAppend',
  'cssBody',
  'cssPrepend',
  'cssAppend',
  'resWrite',
  'resWriteRaw',
  'resMerge'
];
var BODY_PROTOCOLS_LEN = BODY_PROTOCOLS.length;

function notAllowCache(resRules) {
  for (var i = 0; i < BODY_PROTOCOLS_LEN; i++) {
    if (resRules[BODY_PROTOCOLS[i]]) {
      return true;
    }
  }
}

function joinArr(src, dest) {
  if (!src || !dest) {
    return src || dest;
  }
  return src.concat(dest);
}

function pipeClient(req, client) {
  if (req._hasError) {
    client.destroy();
  } else if (req.noReqBody) {
    util.drain(req, function () {
      if (!req._hasError) {
        client.end();
      }
    });
  } else {
    req.pipe(client);
  }
}

function showDnsError(res, err) {
  res.response(
    util.wrapGatewayError('DNS Lookup Failed\r\n' + util.getErrorStack(err))
  );
}

function setCookies(headers, data) {
  var newCookies = data.headers['set-cookie'];
  if (!Array.isArray(newCookies)) {
    if (!newCookies || typeof newCookies !== 'string') {
      return;
    }
    newCookies = newCookies.split(',');
  }
  if (newCookies.length) {
    var cookies = headers['set-cookie'];
    var isArray = Array.isArray(cookies);
    if (!isArray && cookies) {
      isArray = true;
      cookies = [String(cookies)];
    }
    if (isArray) {
      var newNameMap = {};
      newCookies.forEach(function (cookie) {
        var index = cookie.indexOf('=');
        var name = index == -1 ? name : cookie.substring(0, index);
        newNameMap[name] = 1;
      });
      cookies.forEach(function (cookie) {
        var index = cookie.indexOf('=');
        var name = index == -1 ? name : cookie.substring(0, index);
        if (!newNameMap[name]) {
          newCookies.push(cookie);
        }
      });
    }
    headers['set-cookie'] = newCookies;
    delete data.headers['set-cookie'];
  }
}

function handleReplace(res, replacement) {
  if (!replacement) {
    return;
  }

  var type = util.getContentType(res.headers);
  if (!type || type == 'IMG') {
    return;
  }

  Object.keys(replacement).forEach(function (pattern) {
    var value = replacement[pattern];
    if (
      util.isOriginalRegExp(pattern) &&
      (pattern = util.toOriginalRegExp(pattern))
    ) {
      res.addTextTransform(new ReplacePatternTransform(pattern, value, util.isSSE(res)));
    } else if (pattern) {
      res.addTextTransform(new ReplaceStringTransform(pattern, value, util.isSSE(res)));
    }
  });
}

function getWriterFile(file, statusCode) {
  if (!file || statusCode == 200) {
    return file;
  }

  return file + '.' + statusCode;
}

function readFirstChunk(req, res, src, cb) {
  var ports = req._pipePluginPorts;
  if (!cb) {
    if (ports.reqReadPort || ports.reqWritePort) {
      delete req.headers['content-length'];
    }
    return ports.reqReadPort ? req.getPayload(res, 1) : res();
  }
  if (ports.resReadPort || ports.resWritePort) {
    delete src.headers['content-length'];
  }
  if (!ports.resReadPort) {
    return cb();
  }
  res.prepareSrc(src, function (stream) {
    util.readOneChunk(stream, cb);
  });
}

function checkH2(req, isHttps) {
  if (!config.enableH2) {
    return;
  }
  req.useH2 = req.isH2;
  var d = req.disable;
  var e = req.enable;
  if (isHttps) {
    if (d.h2 || d.httpsH2) {
      req.useH2 = false;
    } else if (e.h2 || e.httpsH2) {
      req.useH2 = true;
    }
  } else {
    if (d.httpH2) {
      req.useH2 = false;
    } else if (e.httpH2) {
      req.useH2 = true;
    }
    req.useHttpH2 = req.useH2;
  }
}

module.exports = function (req, res, next) {
  var origProto;
  var resRules = req.rules;

  req.request = function (options) {
    readFirstChunk(req, function () {
      options = options || req.options;
      req.realUrl = res.realUrl = options.isPlugin
        ? req._realUrl || req.fullUrl
        : options.href;
      var originPort = options.port;
      var originHost = options.host;
      var now = Date.now();
      rules.getClientCert(req, function (key, cert, isPfx, cacheKey) {
        rules.getProxy(
          options.href,
          options.isPlugin ? null : req,
          function (err, hostIp, hostPort) {
            var proxyRule = resRules.proxy;
            var proxyUrl =
              !options.isPlugin && proxyRule
                ? util.rule.getMatcher(proxyRule)
                : null;
            var headers = req.headers;
            var curUrl,
              auth,
              isInternalProxy,
              isHttpsProxy,
              origPath,
              origProxy;
            if (!hostIp) {
              if (options.localDNS && net.isIP(options.host)) {
                curUrl = options.host;
              } else if (proxyUrl) {
                isHttpsProxy = proxyRule.isHttps;
                isInternalProxy = proxyRule.isInternal || util.isInternalProxy(req);
                if (isInternalProxy) {
                  req._isInternalProxy = true;
                  if (options.protocol === 'https:') {
                    headers[config.HTTPS_FIELD] = 1;
                    origProto = options.protocol;
                    options.protocol = null;
                  }
                } else if (proxyRule.isHttp2https) {
                  options.protocol = 'https:';
                }
                curUrl = 'http:' + util.removeProtocol(proxyUrl);
              } else {
                curUrl = options.href;
              }
            }
            req.curUrl = curUrl;
            req.setServerPort =
              req.setServerPort ||
              function (serverPort) {
                req.serverPort = serverPort;
              };
            rules.resolveHost(
              req,
              function (err, ip, port, hostRule) {
                var setHostsInfo = function (_ip, _port, _host, withPort) {
                  ip = _ip || '127.0.0.1';
                  port = _port;
                  req.dnsTime = Date.now() - now;
                  req.hostIp = util.joinIpPort(_ip, withPort && _port);
                  if (_host) {
                    resRules.host = _host;
                  }
                };
                if (proxyUrl && proxyRule && hostRule) {
                  proxyRule.host = hostRule;
                  hostRule = null;
                }
                setHostsInfo(hostIp || ip, hostPort || port, hostRule);
                if (err) {
                  showDnsError(res, err);
                  return;
                }
                if (req.disable.keepalive) {
                  req.disable.keepAlive = true;
                }
                var isHttps = options.protocol == 'https:';
                var proxyOptions, isProxyPort, isSocks;
                var setAgent = function (disable) {
                  if (disable || req.disable.keepAlive || (isHttps && cert)) {
                    options.agent = false;
                  } else {
                    options.agent = isHttps
                      ? config.httpsAgent
                      : config.httpAgent;
                  }
                };
                checkH2(req, isHttps);
                if (proxyUrl) {
                  proxyOptions = parseUrl(proxyUrl);
                  proxyOptions.host = ip;
                  proxyOptions.auth = proxyOptions.auth || req._pacAuth;
                  isSocks = proxyRule.isSocks;
                  var proxyPort = proxyOptions.port;
                  if (!proxyPort) {
                    proxyPort = proxyOptions.port = isSocks
                      ? 1080
                      : isHttpsProxy
                      ? 443
                      : 80;
                  }
                  if (proxyOptions.auth) {
                    auth =
                      'Basic ' +
                      util.toBuffer(proxyOptions.auth + '').toString('base64');
                  } else {
                    auth = headers['proxy-authorization'];
                  }
                  if (
                    isHttps ||
                    (req.useH2 && !isInternalProxy) ||
                    isSocks ||
                    isHttpsProxy ||
                    req._phost
                  ) {
                    isProxyPort = util.isProxyPort(proxyPort);
                    if (isProxyPort && util.isLocalAddress(ip)) {
                      req.setServerPort(config.port);
                      res.response(
                        util.wrapResponse({
                          statusCode: 302,
                          headers: {
                            location:
                              'http://' +
                              util.joinIpPort(ip, config.port) +
                              (options.path || '')
                          }
                        })
                      );
                    } else {
                      var curServerPort = options.port || (isHttps ? 443 : 80);
                      var proxyHeaders = {
                        host: util.joinIpPort(options.hostname, curServerPort),
                        'proxy-connection': req.disable.proxyConnection
                          ? 'close'
                          : 'keep-alive'
                      };
                      pluginMgr.getTunnelKeys().forEach(function (k) {
                        var val = headers[k];
                        if (val) {
                          proxyHeaders[k] = val;
                        }
                      });
                      if (auth) {
                        proxyHeaders['proxy-authorization'] = auth;
                      }
                      if (req.disable.proxyUA) {
                        delete proxyHeaders['user-agent'];
                      } else if (headers['user-agent']) {
                        proxyHeaders['user-agent'] = headers['user-agent'];
                      }
                      if (!util.isLocalAddress(req.clientIp)) {
                        proxyHeaders[config.CLIENT_IP_HEAD] = req.clientIp;
                      }
                      if (isHttps || req.useH2) {
                        util.checkIfAddInterceptPolicy(proxyHeaders, headers);
                      }
                      if (isProxyPort) {
                        proxyHeaders[config.WEBUI_HEAD] = 1;
                      }
                      if (util.isProxyPort(curServerPort) || util.isLocalPHost(req, isHttps)) {
                        headers[config.WEBUI_HEAD] = 1;
                      }
                      var clientId = req.headers[config.CLIENT_ID_HEADER];
                      if (clientId) {
                        proxyHeaders[config.CLIENT_ID_HEADER] = clientId;
                      }
                      util.setClientId(
                        proxyHeaders,
                        req.enable,
                        req.disable,
                        req.clientIp,
                        isInternalProxy
                      );
                      var phost = req._phost;
                      var opts = {
                        isSocks: isSocks,
                        isHttps: isHttps,
                        _phost: phost,
                        proxyServername: isHttpsProxy
                          ? proxyOptions.hostname
                          : null,
                        proxyHost: ip,
                        clientIp: proxyHeaders[config.CLIENT_IP_HEAD],
                        proxyPort: proxyPort,
                        url: options.href,
                        auth: proxyOptions.auth,
                        headers: proxyHeaders
                      };
                      if (phost) {
                        options.host = phost.hostname;
                        if (phost.port > 0) {
                          options.port = phost.port;
                        } else if (!options.port) {
                          options.port = isHttps ? 443 : 80;
                        }
                        proxyHeaders.host = util.joinIpPort(options.host, options.port);
                      } else {
                        options.host = options.hostname;
                      }
                      options._proxyOptions = opts;
                      opts.proxyType = isSocks
                        ? 'socks'
                        : isHttpsProxy
                        ? 'https'
                        : 'http';
                      options._proxyPort = opts.proxyPort;
                      origProxy = opts;
                      request(options);
                    }
                    return;
                  }

                  if (auth) {
                    headers['proxy-authorization'] = auth;
                  }
                }

                req.hostIp = util.joinIpPort(ip, port);
                port = proxyOptions ? proxyOptions.port : port || options.port;
                options.host = ip; //设置ip
                var curPort = port || (isHttps ? 443 : 80);
                isProxyPort = util.isProxyPort(curPort);
                var isLocalAddress = util.isLocalAddress(options.host);
                if (isProxyPort && isLocalAddress) {
                  var redirectHost = config.customLocalUIHost || ip;
                  var redirectPort = config.realPort || config.port;
                  res.response(
                    util.wrapResponse({
                      statusCode: 302,
                      headers: {
                        location:
                          'http://' +
                          util.joinIpPort(redirectHost, redirectPort) +
                          (options.path || '')
                      }
                    })
                  );
                } else {
                  if (
                    isProxyPort ||
                    util.isProxyPort(options.port || (isHttps ? 443 : 80)) ||
                    util.isLocalPHost(req, isHttps)
                  ) {
                    headers[config.WEBUI_HEAD] = 1;
                  }
                  setAgent(isLocalAddress);
                  request(options, port, true);
                }
                function request(options, serverPort, direct) {
                  options.headers = headers;
                  options.method = req.method;
                  options.rejectUnauthorized = config.rejectUnauthorized;
                  if (
                    !options.isPlugin &&
                    !req._customHost &&
                    (req.fullUrl !== req.realUrl || !headers.host)
                  ) {
                    headers.host = originHost;
                  }
                  if (req.disable.keepAlive) {
                    headers.connection = 'close';
                  }
                  if (direct) {
                    options.port = serverPort;
                    if (proxyUrl) {
                      origPath = options.path || '';
                    }
                  }

                  delete options.hostname; //防止自动dns
                  delete options.protocol;
                  if (isHttps && !req.disable.servername) {
                    options.servername = util.parseHost(headers.host)[0];
                  }
                  var piped;
                  var maxRetryCount = 1;
                  var retryCount = 0;
                  var retryXHost = 0;
                  var resetCount = 0;
                  var curClient, timer;
                  var setProxyAgent = function (options, proxyOpts) {
                    proxyOpts.cacheKey = options.cacheKey;
                    proxyOpts.proxyTunnelPath = util.getProxyTunnelPath(
                      req,
                      isHttps
                    );
                    proxyOpts.enableIntercept = true;
                    options.agent = proxyOpts.isSocks
                      ? config.getSocksAgent(proxyOpts)
                      : config.getHttpsAgent(proxyOpts, options);
                  };
                  var retry = function (err) {
                    clearTimeout(timer);
                    timer = null;
                    if (curClient) {
                      curClient.removeListener('error', retry);
                      curClient.removeListener('close', retry);
                      curClient.on('error', util.noop);
                      curClient.destroy();
                      curClient = null;
                    }
                    if (req._hasError || req._hasRespond) {
                      return;
                    }
                    if (
                      err &&
                      isHttps &&
                      !options.ciphers &&
                      util.isCiphersError(err)
                    ) {
                      options.ciphers = util.getCipher(resRules);
                      return send();
                    }
                    if (retryCount >= maxRetryCount) {
                      var toHttp;
                      if (
                        isHttps &&
                        (!piped || req.noReqBody) &&
                        util.checkTlsError(err) &&
                        util.checkAuto2Http(req, ip, proxyUrl)
                      ) {
                        isHttps = false;
                        toHttp = true;
                        req.httpsTime = req.httpsTime || Date.now();
                        req.useHttp = true;
                        if (origProxy) {
                          origProxy.isHttps = false;
                          if (req._phost && !req._phost.port) {
                            options.port = 80;
                            origProxy.headers.host =
                              req._phost.hostname + ':80';
                          }
                          setProxyAgent(options, origProxy);
                        } else {
                          setAgent(util.isLocalAddress(ip));
                        }
                      }
                      var code = err && err.code;
                      if (
                        !toHttp &&
                        (resetCount > 1 ||
                          (code !== 'EPROTO' && code !== 'ECONNRESET') ||
                          (piped && !req.noReqBody))
                      ) {
                        var stack = util.getErrorStack(
                          err || new Error('socket connect timeout')
                        );
                        res.response(util.wrapGatewayError(stack));
                      } else {
                        ++resetCount;
                        send();
                      }
                      return;
                    }
                    ++retryCount;
                    if (proxyUrl) {
                      if (X_RE.test(proxyUrl)) {
                        proxyUrl = '';
                        req._phost = undefined;
                        if (isInternalProxy) {
                          isHttps = origProto === 'https:';
                        }
                        req.curUrl = req.realUrl;
                        delete options._proxyPort;
                        rules.resolveHost(
                          req,
                          function (_err, _ip, _port, _host) {
                            setAgent(util.isLocalAddress(_ip));
                            setHostsInfo(_ip, _port, _host, true);
                            if (_err) {
                              showDnsError(res, _err);
                              return;
                            }
                            options.host = ip;
                            options.port = _port || originPort;
                            ++maxRetryCount;
                            send();
                          }
                        );
                        return;
                      }
                    } else if (
                      retryXHost < 2 &&
                      req.rules.host &&
                      X_RE.test(req.rules.host.matcher)
                    ) {
                      ++maxRetryCount;
                      ++retryXHost;
                      if (retryXHost > 1) {
                        req.curUrl = req.realUrl;
                        delete options._proxyPort;
                        rules.lookupHost(req, function (_err, _ip) {
                          setHostsInfo(_ip);
                          if (_err) {
                            showDnsError(res, _err);
                            return;
                          }
                          options.host = ip;
                          options.port = originPort;
                          send();
                        });
                        return;
                      }
                    } else if (
                      isHttps &&
                      util.checkAuto2Http(req, ip, proxyUrl)
                    ) {
                      ++maxRetryCount;
                      if (maxRetryCount > 2 || util.checkTlsError(err)) {
                        isHttps = false;
                        req.httpsTime = req.httpsTime || Date.now();
                        req.useHttp = true;
                        setAgent(util.isLocalAddress(options.host));
                      }
                    }
                    send();
                  };
                  var send = function (sock) {
                    if (req._hasError) {
                      return;
                    }
                    req.useH2 = false;
                    req.setServerPort(
                      options._proxyPort || options.port || (isHttps ? 443 : 80)
                    );
                    if (origPath != null && proxyUrl) {
                      origPath = null;
                      options.path =
                        (isHttps ? 'https:' : 'http:') +
                        '//' +
                        (headers.host || options.host) +
                        (options.path || '/');
                    }
                    var useHttps = isHttps;
                    if (sock) {
                      options.agent = null;
                      options.createConnection = function () {
                        return sock;
                      };
                    } else {
                      var proxyOpts = options._proxyOptions;
                      if (proxyOpts) {
                        if (!req.useHttpH2 || proxyOpts._phost) {
                          setProxyAgent(options, proxyOpts);
                        } else {
                          options.host = proxyOpts.proxyHost;
                          options.port = proxyOpts.proxyPort;
                          useHttps = useHttps || isHttpsProxy;
                        }
                        delete options._proxyOptions;
                      }
                    }
                    options.protocol = useHttps ? 'https:' : 'http:';
                    if (useHttps && !req.disable.secureOptions) {
                      util.setSecureOptions(options);
                    }
                    try {
                      var client = (useHttps ? https : http).request(
                        options,
                        res.response
                      );
                      curClient = client;
                      req._clientReq = client;
                      client.once('error', retry);
                      client.once('socket', function (socket) {
                        if (socket.connecting || socket._connecting) {
                          if (TIMEOUT) {
                            timer = setTimeout(function () {
                              socket.destroy();
                              timer = null;
                              retry();
                            }, TIMEOUT);
                          }
                          socket.once(
                            isHttpsProxy || isHttps
                              ? 'secureConnect'
                              : 'connect',
                            function () {
                              retryCount = maxRetryCount;
                              piped = true;
                              clearTimeout(timer);
                              timer = null;
                              pipeClient(req, client);
                            }
                          );
                        } else {
                          retryCount = maxRetryCount;
                          piped = true;
                          pipeClient(req, client);
                          socket.resume();
                        }
                      });
                    } catch (e) {
                      res.response(
                        util.wrapGatewayError(util.getErrorStack(e))
                      );
                    }
                  };
                  if (req.disable.clientIp || req.disable.clientIP) {
                    delete headers[config.CLIENT_IP_HEAD];
                  } else {
                    var forwardedFor = util.getMatcherValue(
                      resRules.forwardedFor
                    );
                    if (net.isIP(forwardedFor)) {
                      headers[config.CLIENT_IP_HEAD] = forwardedFor;
                    } else if (net.isIP(req._customXFF)) {
                      headers[config.CLIENT_IP_HEAD] = req._customXFF;
                    } else if (
                      (!options.isPlugin &&
                        !req.enable.clientIp &&
                        !req.enable.clientIP &&
                        !req.enableXFF &&
                        (isHttps || isSocks || !proxyUrl)) ||
                      util.isLocalAddress(req.clientIp)
                    ) {
                      delete headers[config.CLIENT_IP_HEAD];
                    } else {
                      headers[config.CLIENT_IP_HEAD] = req.clientIp;
                    }
                  }
                  util.deleteReqHeaders(req);
                  var optHeaders = options.headers;
                  var transfer =
                    options.method === 'DELETE' &&
                    optHeaders['transfer-encoding'];
                  if (transfer) {
                    delete optHeaders['transfer-encoding'];
                  }
                  var clientId = optHeaders[config.CLIENT_ID_HEADER];
                  if (clientId) {
                    if (!options.isPlugin && !req._customClientId && !util.isKeepClientId(req, proxyUrl)) {
                      req._origClientId = clientId;
                      util.removeClientId(optHeaders);
                    }
                    req.setClientId && req.setClientId(clientId);
                  } else {
                    util.setClientId(
                      optHeaders,
                      req.enable,
                      req.disable,
                      req.clientIp,
                      isInternalProxy
                    );
                  }
                  if (
                    req.useH2 &&
                    (isInternalProxy ||
                      headers[config.HTTPS_FIELD] ||
                      options.isPlugin)
                  ) {
                    headers[config.ALPN_PROTOCOL_HEADER] = 'h2';
                  }
                  options.headers = optHeaders = formatHeaders(
                    optHeaders,
                    req.rawHeaderNames
                  );
                  delete headers[config.WEBUI_HEAD];
                  delete headers[config.HTTPS_FIELD];
                  delete headers[config.ALPN_PROTOCOL_HEADER];
                  if (transfer) {
                    optHeaders['Transfer-Encoding'] = transfer;
                  }
                  if (options.isPlugin) {
                    optHeaders[config.PLUGIN_HOOK_NAME_HEADER] =
                      config.PLUGIN_HOOKS.HTTP;
                  }
                  req.noReqBody = !util.hasRequestBody(req);
                  if (
                    req.method === 'DELETE' &&
                    (req._hasInjectBody ||
                      req.headers['transfer-encoding'] ||
                      req.headers['content-length'] > 0)
                  ) {
                    req.useH2 = false;
                  }
                  req.setServerPort(
                    options._proxyPort || options.port || (isHttps ? 443 : 80)
                  );
                  req.options = options;
                  isHttps &&
                    util.setClientCert(options, key, cert, isPfx, cacheKey);
                  util.addMatchedRules(req);
                  h2.request(req, res, send);
                }
              },
              req.pluginRules,
              req.rulesFileMgr,
              req.headerRulesMgr
            );
          }
        );
      });
    });
  };

  res.response = function (_res) {
    if (req._hasRespond) {
      return;
    }
    req._hasRespond = true;
    res._srcResponse = _res;
    if (_res.realUrl) {
      req.realUrl = res.realUrl = _res.realUrl;
    }
    var headers = _res.headers;
    res.headers = req.resHeaders = headers;
    res._originEncoding = headers['content-encoding'];
    req.statusCode = _res.statusCode;
    if (_res.rawHeaderNames) {
      res.rawHeaderNames = _res.rawHeaderNames;
    } else {
      res.rawHeaderNames = _res.rawHeaderNames = Array.isArray(_res.rawHeaders)
        ? getRawHeaderNames(_res.rawHeaders)
        : {};
    }
    _res.on('error', function (err) {
      res.emit('error', err);
    });
    if (!req.isPluginReq && headers[config.PROXY_ID_HEADER] === 'h2') {
      req.useH2 = true;
      delete headers[config.PROXY_ID_HEADER];
    }
    if (req.disable.additionalHeaders) {
      delete headers[config.ADDITIONAL_HEAD];
    }
    util.drain(req, function () {
      readFirstChunk(req, res, _res, function (firstChunk) {
        pluginMgr.getResRules(req, _res, function () {
          var replaceStatus = util.getMatcherValue(resRules.replaceStatus);
          if (replaceStatus && replaceStatus != _res.statusCode) {
            res.statusCode = _res.statusCode = replaceStatus;
            if (!util.isDisableUserLogin(resRules.replaceStatus, req)) {
              util.handleStatusCode(replaceStatus, headers);
            }
          }
          if (req.disable['301'] && _res.statusCode == 301) {
            res.statusCode = _res.statusCode = 302;
          }

          var ruleList = [
            resRules.resHeaders,
            resRules.resCookies,
            resRules.resCors,
            resRules.resReplace,
            resRules.resMerge,
            resRules.trailers
          ];
          util.parseRuleJson(
            ruleList,
            function (
              headers,
              cookies,
              cors,
              replacement,
              params,
              newTrailers
            ) {
              var data = {};
              if (headers) {
                data.headers = extend(data.headers || {}, headers);
              }
              if (data.body && typeof data.body !== 'string') {
                try {
                  data.body = JSON.stringify(data.body);
                } catch (e) {}
              }
              if (data.headers) {
                data.headers = util.lowerCaseify(
                  data.headers,
                  res.rawHeaderNames
                );
                if (typeof data.headers['content-type'] !== 'string') {
                  delete data.headers['content-type'];
                }
              }

              util.setResCookies(_res, cookies, req);
              util.setResCors(_res, cors, req);

              var cache = util.getMatcherValue(resRules.cache);
              var enable = req.enable;
              if (cache === 'reserve' || cache === 'keep' || enable.keepAllCache) {
                req._customCache = true;
              } else {
                var maxAge = parseInt(cache, 10);
                var noCache =
                  /^(?:no|no-cache|no-store)$/i.test(cache) || maxAge < 0;
                if (maxAge > 0 || noCache) {
                  req._customCache = true;
                  util.setHeaders(data, {
                    'cache-control': noCache
                      ? /^no-store$/i.test(cache)
                        ? 'no-store'
                        : 'no-cache'
                      : 'max-age=' + maxAge,
                    expires: new Date(
                      Date.now() + (noCache ? -60000000 : maxAge * 1000)
                    ).toGMTString(),
                    pragma: noCache ? 'no-cache' : ''
                  });
                }
              }

              if (resRules.attachment) {
                var attachment =
                  util.getMatcherValue(resRules.attachment) ||
                  util.getFilename(req.fullUrl);
                util.setHeader(
                  data,
                  'content-disposition',
                  'attachment; filename="' +
                    util.encodeNonLatin1Char(attachment) +
                    '"'
                );
              }

              if (resRules.resCharset) {
                data.charset = util.getMatcherValue(resRules.resCharset);
              }

              var resSpeed = util.getMatcherValue(resRules.resSpeed);
              resSpeed = resSpeed && parseFloat(resSpeed);
              if (resSpeed > 0) {
                data.speed = resSpeed;
              }


              var _resHeaders = _res.headers;
              if (data.headers) {
                setCookies(_resHeaders, data);
                extend(_resHeaders, data.headers);
              }

              
              const ruleRaw = req.rules && req.rules.rule && req.rules.rule.raw;
              _resHeaders['__iproxy-host-ip__'] = req.hostIp || LOCALHOST;

              const strwrap = (str) => str.replace(/[^\x00-\x7F]/g, '_');

              _resHeaders['__iproxy-rules__'] = strwrap(JSON.stringify(ruleRaw) || 'none');
              _resHeaders['__iproxy-real-url__'] = strwrap(req.realUrl || 'none');

              _resHeaders['__iproxy-help__'] = 'See https://github.com/xcodebuild/iproxy';

              if (data.charset && typeof data.charset == 'string') {
                resType = _resHeaders['content-type'];
                resType =
                  typeof resType == 'string' ? resType.trim().split(';')[0] : '';
                resType =
                  resType ||
                  mime.lookup(
                    req.fullUrl.replace(/[?#].*$/, ''),
                    'text/html'
                  );
                _resHeaders['content-type'] = resType + '; charset=' + data.charset;
              } else {
                delete data.charset;
                if (resRules.resType) {
                  var newType = util.getMatcherValue(resRules.resType).split(';');
                  var type = newType[0];
                  newType[0] =
                    !type || type.indexOf('/') != -1
                      ? type
                      : (type === 'sse' ? 'text/event-stream' : mime.lookup(type, type));
                  _resHeaders['content-type'] = util.getNewType(newType.join(';'), _resHeaders);
                }
              }
              var delProps = util.parseDelProps(req);
              util.setCharset(_resHeaders, data.charset, delProps.resType, delProps.resCharset);
              if (!_resHeaders.pragma) {
                delete _resHeaders.pragma;
              }
              var hr = util.parseHeaderReplace(resRules.headerReplace);
              util.handleHeaderReplace(_resHeaders, hr.res);
              if (_resHeaders.location) {
                //nodejs的url只支持ascii，对非ascii的字符要encodeURIComponent，否则传到浏览器是乱码
                _resHeaders.location = util.encodeNonLatin1Char(_resHeaders.location);
              }
              var resType = util.getContentType(_resHeaders);
              var charset = util.getCharset(_resHeaders['content-type']);
              var isHtml = resType === 'HTML';
              var isJs = isHtml || resType === 'JS';
              var isCss = isHtml || resType === 'CSS';
              var hasResBody = util.hasBody(_res, req);
              var injectRules = [
                resRules.resBody,
                resRules.resPrepend,
                resRules.resAppend,
                isHtml && resRules.htmlAppend,
                isJs && resRules.jsAppend,
                isCss && resRules.cssAppend,
                isHtml && resRules.htmlBody,
                isJs && resRules.jsBody,
                isCss && resRules.cssBody,
                isHtml && resRules.htmlPrepend,
                isJs && resRules.jsPrepend,
                isCss && resRules.cssPrepend
              ];
              if (isHtml) {
                data.isHtml = true;
                if (util.isEnable(req, 'strictHtml')) {
                  data.strictHtml = true;
                  injectRules.forEach(function(rule) {
                    if (rule) {
                      rule.strictHtml = true;
                    }
                  });
                } else if (util.isEnable(req, 'safeHtml')) {
                  data.safeHtml = true;
                  injectRules.forEach(function(rule) {
                    if (rule) {
                      rule.safeHtml = true;
                    }
                  });
                }
              }
              util.getRuleValue(injectRules, function (
                  resBody,
                  resPrepend,
                  resAppend,
                  htmlAppend,
                  jsAppend,
                  cssAppend,
                  htmlBody,
                  jsBody,
                  cssBody,
                  htmlPrepend,
                  jsPrepend,
                  cssPrepend
                ) {
                if (req._hasError) {
                  return;
                }
                if (resBody != null) {
                  data.body = resBody || util.EMPTY_BUFFER;
                }
                data.top = resPrepend;
                data.bottom = resAppend;

                var speedTransform = data.speed || data.delay ? new SpeedTransform(data) : null;
                delete data.headers;
                delete data.speed;
                delete data.delay;
                if (isJs || resType === 'JSON' || !_resHeaders['content-type']) {
                  var delBodyProps = util.parseDelResBody(req);
                  params = util.isEmptyObject(params) ? null : params;
                  if (params || delBodyProps) {
                    var transform = new Transform();
                    var interrupt;
                    var ctn = '';
                    transform._transform = function (text, _, callback) {
                      if (text) {
                        if (!interrupt) {
                          ctn += text;
                          text = null;
                          if (
                            ((isHtml || !_resHeaders['content-type']) && !LIKE_JSON_RE.test(ctn)) ||
                            Buffer.byteLength(ctn) > MAX_RES_SIZE
                          ) {
                            interrupt = true;
                            text = ctn;
                            ctn = null;
                          }
                        }
                      } else if (ctn) {
                        text = ctn.replace(JSON_RE, function (json) {
                          var obj = util.parseRawJson(json);
                          if (obj) {
                            if (params) {
                              obj = extend(true, obj, params);
                            }
                            util.deleteProps(obj, delBodyProps);
                            json = JSON.stringify(obj);
                          }
                          return json;
                        });
                        ctn = null;
                      } else if (!interrupt) {
                        if (params) {
                          util.deleteProps(params, delBodyProps);
                          try {
                            text = JSON.stringify(params);
                          } catch (e) {}
                        }
                      }

                      callback(null, text);
                    };
                    res.addTextTransform(transform);
                  }
                }
                var top, body, bottom;
                if (isHtml) {
                  top = joinArr(data.top, cssPrepend);
                  top = joinArr(top, htmlPrepend);
                  data.top = joinArr(top, jsPrepend);
                  body = joinArr(data.body, cssBody);
                  body = joinArr(body, htmlBody);
                  data.body = joinArr(body, jsBody);
                  bottom = joinArr(data.bottom, cssAppend);
                  bottom = joinArr(bottom, htmlAppend);
                  data.bottom = joinArr(bottom, jsAppend);
                } else {
                  if (isJs) {
                    top = jsPrepend;
                    body = jsBody;
                    bottom = jsAppend;
                  } else if (isCss) {
                    top = cssPrepend;
                    body = cssBody;
                    bottom = cssAppend;
                  }
                  if (top) {
                    top = util.toBuffer(top, charset);
                    data.top = data.top ? Buffer.concat([data.top, CRLF, top]) : top;
                  }
                  if (body) {
                    body = util.toBuffer(body, charset);
                    data.body = data.body ? Buffer.concat([data.body, CRLF, body]) : body;
                  }
                  if (bottom) {
                    bottom = util.toBuffer(bottom, charset);
                    data.bottom = data.bottom ? Buffer.concat([data.bottom, CRLF, bottom]) : bottom;
                  }
                }

                if (data.body || data.top || data.bottom) {
                  !enable.keepAllCSP &&
                      !enable.keepCSP &&
                      util.disableCSP(_resHeaders);
                  !req._customCache &&
                      !enable.keepCache &&
                      util.disableResStore(_resHeaders);
                }

                if (!hasResBody) {
                  delete data.speed;
                  delete data.body;
                  delete data.top;
                  delete data.bottom;
                } else {
                  util.removeResBody(req, data);
                }
                if (util.isWhistleTransformData(data)) {
                  res.addZipTransform(new WhistleTransform(data));
                }
                if (hasResBody) {
                  handleReplace(res, replacement);
                }
                  //一定放在最后，确保能过滤到动态注入的内容
                if (speedTransform) {
                  res.add(speedTransform);
                }

                var bodyFile = hasResBody
                    ? getWriterFile(
                        util.getRuleFile(resRules.resWrite),
                        _res.statusCode
                      )
                    : null;
                var rawFile = getWriterFile(
                    util.getRuleFile(resRules.resWriteRaw),
                    _res.statusCode
                  );
                util.getFileWriters(
                    [bodyFile, rawFile],
                    function (writer, rawWriter) {
                      if (req._hasError) {
                        return;
                      }
                      res.on('src', function (_res) {
                        if (writer) {
                          res.addZipTransform(
                            new FileWriterTransform(writer, _res)
                          );
                        }

                        if (rawWriter) {
                          res.addZipTransform(
                            new FileWriterTransform(
                              rawWriter,
                              _res,
                              true,
                              req
                            )
                          );
                        }
                      });
                      var resHeaders = delProps.resHeaders;
                      if (resHeaders) {
                        Object.keys(resHeaders).forEach(function (prop) {
                          delete _resHeaders[prop];
                        });
                      }
                      if (_resHeaders[config.ALPN_PROTOCOL_HEADER] === 'h2') {
                        req.useH2 = true;
                      }
                      util.delay(
                        util.getMatcherValue(resRules.resDelay),
                        function () {
                          if (req._hasError) {
                            return;
                          }
                          if (util.needAbortRes(req)) {
                            req.__resHeaders = _res.headers;
                            req.__statusCode = _res.statusCode;
                            return res.destroy();
                          }
                          res.src(_res, null, firstChunk);
                          firstChunk = null;
                          var rawNames = res.rawHeaderNames || {};
                          var encoding = util.getEnableEncoding(enable);
                          if (encoding) {
                            rawNames['content-encoding'] =
                              rawNames['content-encoding'] ||
                              'Content-Encoding';
                            _resHeaders['content-encoding'] = encoding;
                            delete _resHeaders['content-length'];
                          } else if (
                            req._pipePluginPorts.resReadPort ||
                            req._pipePluginPorts.resWritePort
                          ) {
                            delete req.headers['content-length'];
                          }
                          util.disableResProps(req, _resHeaders);
                          if (req._filters.showHost || enable.showHost) {
                            _resHeaders['x-host-ip'] = req.hostIp || LOCALHOST;
                          }
                          util.setResponseFor(
                            resRules,
                            _resHeaders,
                            req,
                            req.hostIp,
                            req._phost
                          );
                          pluginMgr.postStats(req, res);
                          if (
                            !hasResBody &&
                            _resHeaders['content-length'] > 0 &&
                            !util.isHead(req)
                          ) {
                            delete _resHeaders['content-length'];
                          }
                          if (!req.disable.trailerHeader) {
                            util.addTrailerNames(
                              _res,
                              newTrailers,
                              rawNames,
                              delProps.trailers,
                              req
                            );
                          }
                          if (req.enableCustomParser) {
                            if (
                              _res.isCustomRes ||
                              _resHeaders['x-whistle-disable-custom-frames']
                            ) {
                              delete _resHeaders[
                                'x-whistle-disable-custom-frames'
                              ];
                              req.disableCustomParser();
                            } else {
                              req.enableCustomParser(_res);
                            }
                          }
                          var curHeaders = _resHeaders;
                          if (req.fromComposer) {
                            curHeaders = extend({}, _resHeaders);
                            curHeaders['x-whistle-req-id'] = req.reqId;
                          }
                          util.addMatchedRules(req, _res);
                          try {
                            res.writeHead(
                              _res.statusCode,
                              formatHeaders(curHeaders, rawNames)
                            );
                            util.onResEnd(_res, function () {
                              var trailers = _res.trailers;
                              if (
                                !res.chunkedEncoding ||
                                req.disable.trailers ||
                                req.disable.trailer ||
                                (util.isEmptyObject(trailers) &&
                                  util.isEmptyObject(newTrailers))
                              ) {
                                return;
                              }
                              var rawHeaderNames = _res.rawTrailers
                                ? getRawHeaderNames(_res.rawTrailers)
                                : {};
                              if (newTrailers) {
                                newTrailers = util.lowerCaseify(
                                  newTrailers,
                                  rawHeaderNames
                                );
                                if (trailers) {
                                  extend(trailers, newTrailers);
                                } else {
                                  trailers = newTrailers;
                                }
                              }
                              var delTrailers = delProps.trailers;
                              if (delTrailers) {
                                Object.keys(delTrailers).forEach(function (prop) {
                                  delete trailers[prop];
                                });
                              }
                              util.handleHeaderReplace(trailers, hr.trailer);
                              res.setCurTrailers &&
                                res.setCurTrailers(trailers, rawHeaderNames);
                              try {
                                util.removeIllegalTrailers(trailers);
                                res.addTrailers(
                                  formatHeaders(trailers, rawHeaderNames)
                                );
                              } catch (e) {}
                            });
                            if (
                              res.flushHeaders &&
                              (!req.disable.flushHeaders ||
                                enable.flushHeaders)
                            ) {
                              res.flushHeaders();
                            }
                          } catch (e) {
                            util.emitError(res, e);
                          }
                        }
                      );
                    },
                    util.isEnable(req, 'forceReqWrite')
                  );
              },
                !hasResBody,
                charset,
                isHtml,
                req
              );
            },
            req
          );
        });
      });
    });
  };
  var resHeaders = {};
  var svRes = util.getStatusCodeFromRule(resRules, req);
  if (svRes) {
    req.hostIp = LOCALHOST;
    resHeaders.Connection = 'close';
    res.response(util.wrapResponse(svRes));
    return;
  }

  notAllowCache(resRules) && util.disableReqCache(req.headers);
  if (!req._hasError) {
    next();
  }
};