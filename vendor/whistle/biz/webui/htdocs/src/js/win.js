var $ = require('jquery');

var alertDialog;
var confirmDialog;
var handleConfirm;

function createAlert() {
  if (!alertDialog) {
    alertDialog = $(
      '<div class="modal fade w-win-dialog" tabindex="-1" role="dialog">' +
        '<div class="modal-dialog" role="document">' +
        '<div class="modal-content">' +
        '<div class="modal-body">' +
        '<pre class="alert alert-danger"></pre>' +
        '</div>' +
        '<div class="modal-footer">' +
        '<button type="button" class="btn btn-default" data-dismiss="modal">Close</button>' +
        '<button type="button" class="btn btn-primary w-copy-text-with-tips" data-dismiss="modal"></button>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '</div>'
    );
  }
  return alertDialog;
}

function createConfirm() {
  if (!confirmDialog) {
    confirmDialog = $(
      '<div class="modal fade w-win-dialog" tabindex="-1" role="dialog">' +
        '<div class="modal-dialog" role="document">' +
        '<div class="modal-content">' +
        '<div class="modal-body">' +
        '<pre></pre>' +
        '</div>' +
        '<div class="modal-footer">' +
        '<button type="button" class="btn btn-default w-win-cancel" data-dismiss="modal">Cancel</button>' +
        '<button type="button" class="btn btn-danger w-win-delete-all" data-dismiss="modal">Delete All</button>' +
        '<button type="button" class="btn btn-primary w-win-confirm" data-dismiss="modal">Confirm</button>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '</div>'
    );
    confirmDialog.on('click', '.w-win-cancel', function () {
      if (typeof handleConfirm === 'function') {
        handleConfirm(false);
      }
      handleConfirm = null;
    });
    confirmDialog.on('click', '.w-win-delete-all', function () {
      if (typeof handleConfirm === 'function') {
        handleConfirm(2);
      }
      handleConfirm = null;
    });
    confirmDialog.on('click', '.w-win-confirm', function () {
      if (typeof handleConfirm === 'function') {
        handleConfirm(1);
      }
      handleConfirm = null;
    });
  }
  return confirmDialog;
}

function mockAlert(msg, copyText, btnText) {
  createAlert();
  alertDialog.find('pre').text(msg);
  alertDialog.modal('show');
  var btn = alertDialog.find('.w-copy-text-with-tips');
  if (copyText && typeof copyText === 'string') {
    btn.text(btnText || 'Copy');
    btn.show().attr('data-clipboard-text', copyText);
  } else {
    btn.hide();
  }
}

function mockConfirm(msg, cb, removeAllBtn) {
  createConfirm();
  if (confirmDialog.is(':visible')) {
    return;
  }
  confirmDialog.find('.w-win-delete-all')[removeAllBtn ? 'show' : 'hide']();
  handleConfirm = cb;
  confirmDialog.find('pre').text(msg);
  confirmDialog.modal('show');
}

exports.alert = mockAlert;
exports.confirm = mockConfirm;
