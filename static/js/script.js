// 檔案: static/js/script.js
// 
// 【【【 重構 5.0：加入 TMUX 和 視窗化 】】】
//

// --- 1. 獲取所有 UI 元素 ---
const term = new Terminal();
const termContainer = document.getElementById('terminal'); // 【修改】
term.open(termContainer);

const hostInput = document.getElementById('sshHost');
// ... (其他 UI 元素不變) ...

// --- 2. 狀態變數 ---
let isConnected = false;
let socket = null;
let onDataListener = null;

// --- 3. 初始化 UI 狀態 ---
disconnectBtn.disabled = true;


// --- 4. Socket.IO 核心函數 ---

function setupSocket() {
    // ... (此函數【完全不變】) ...
    if (socket) {
        socket.disconnect();
    }
    socket = io(); 

    socket.on('connect', () => {
        term.focus();
        // 【【【 新增：連線後自動列出 tmux 視窗 】】】
        tmuxList();
    });

    if (onDataListener) {
        onDataListener.dispose();
    }
    onDataListener = term.onData(e => {
        if (isConnected && socket) { 
            socket.emit('ssh_input', {input: e});
        }
    });

    socket.on('ssh_output', data => {
        // ... (不變) ...
    });
    
    socket.on('disconnect', () => {
        // ... (不變) ...
    });

    // --- 【【【 全新功能：TMUX UI 更新 】】】 ---
    socket.on('tmux_update', data => {
        const listDiv = document.getElementById('tmux-window-list');
        listDiv.innerHTML = ''; // 清空列表
        
        if (data.windows && data.windows.length > 0) {
            data.windows.forEach(win => {
                const btn = document.createElement('button');
                btn.className = 'tmux-window-btn';
                btn.textContent = `${win.id}: ${win.name}`;
                // 點擊按鈕時，發送 "select" 指令
                btn.onclick = () => tmuxSelect(win.id);
                listDiv.appendChild(btn);
            });
        } else {
            listDiv.innerHTML = '<span>(No tmux windows found)</span>';
        }
    });
}


// --- 5. 連線/斷線 函數 ---

function connectSSH() {
    // ... (此函數【完全不變】) ...
}

function disconnectSSH() {
    // ... (此函數【完全不變】) ...
    
    // 【【【 新增：斷線時清空 tmux 列表 】】】
    document.getElementById('tmux-window-list').innerHTML = '';
}

function selectCommonHost() {
    // ... (不變) ...
}

// --- 6. 輔助函數 (Helper Functions) ---
// ... (setConnectedUI / setDisconnectedUI 不變) ...


// --- 【【【 全新功能：TMUX 前端控制函數 】】】 ---

function tmuxList() {
    if (socket && isConnected) {
        socket.emit('tmux_control', { action: 'list' });
    }
}

function tmuxNew() {
    if (socket && isConnected) {
        const input = document.getElementById('tmuxNewName');
        const name = input.value || 'new-window';
        socket.emit('tmux_control', { action: 'new', name: name });
        input.value = ''; // 清空
    }
}

function tmuxSelect(targetId) {
    if (socket && isConnected) {
        socket.emit('tmux_control', { action: 'select', target: targetId });
        term.focus(); // 讓使用者可以立即輸入
    }
}


// --- 【【【 全新功能：Interact.js 視窗化 】】】 ---

// target elements with the "draggable" class
interact('.draggable')
  .draggable({
    // enable inertial throwing
    inertia: true,
    // keep the element within the area of its parent
    modifiers: [
      interact.modifiers.restrictRect({
        restriction: 'parent',
        endOnly: true
      })
    ],
    // enable autoScroll
    autoScroll: true,
    // 【重要】 限制只能從 .window-header 拖曳
    allowFrom: '.window-header',
    
    listeners: {
      // call this function on every dragmove event
      move: dragMoveListener,
    }
  });

function dragMoveListener (event) {
  var target = event.target
  // keep the dragged position in the data-x/data-y attributes
  var x = (parseFloat(target.getAttribute('data-x')) || 0) + event.dx
  var y = (parseFloat(target.getAttribute('data-y')) || 0) + event.dy

  // translate the element
  target.style.transform = 'translate(' + x + 'px, ' + y + 'px)'

  // update the posiion attributes
  target.setAttribute('data-x', x)
  target.setAttribute('data-y', y)
}

// target elements with the "resizable" class
interact('.resizable')
  .resizable({
    // resize from all edges and corners
    edges: { left: true, right: true, bottom: true, top: true },

    modifiers: [
      // keep the edges inside the parent
      interact.modifiers.restrictEdges({
        outer: 'parent'
      }),

      // minimum size
      interact.modifiers.restrictSize({
        min: { width: 400, height: 200 }
      })
    ],

    inertia: true
  })
  .on('resizemove', function (event) {
    var target = event.target
    var x = (parseFloat(target.getAttribute('data-x')) || 0)
    var y = (parseFloat(target.getAttribute('data-y')) || 0)

    // update the element's style
    target.style.width = event.rect.width + 'px'
    target.style.height = event.rect.height + 'px'

    // translate when resizing from top or left edges
    x += event.deltaRect.left
    y += event.deltaRect.top

    target.style.transform = 'translate(' + x + 'px,' + y + 'px)'

    target.setAttribute('data-x', x)
    target.setAttribute('data-y', y)
    
    // 【【【 關鍵：通知 xterm.js 終端機尺寸已改變 】】】
    // 這一步是必須的，但 xterm.js v4+ 需要 'xterm-addon-fit'
    // 這裡我們先用一個簡化版，未來可以再優化
    // (目前 xterm.js 會被 CSS 的 flex-grow 自動拉伸，
    // 但 PTY 的 cols/rows 可能不會更新)
    // 
    // console.log("Window resized, PTY should be refitted");
  });