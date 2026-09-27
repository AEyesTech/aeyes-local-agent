// 샌드박스 preload(CommonJS). 렌더러에는 확인 표시 구독과 버튼 전송 두 가지만 노출한다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeyesConfirm', {
  onShow: (callback) => {
    ipcRenderer.on('confirm:show', (_event, view) => callback(view));
  },
  decide: (id, button) => {
    ipcRenderer.send('confirm:decide', { id: String(id), button: String(button) });
  },
});
