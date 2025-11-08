// 檔案: static/js/script.js
// 
// 【【【 重構 7.0：導入 FitAddon 並淡化 Tmux Bar 】】】
//

// --- 1. 全域變數 (最小化) ---
let isConnected = false;
let socket = null;
let onDataListener = null; // 用於 xterm.js 的 'onData'

// 建立 Xterm 實例 (這在全域是安全的)
const term = new Terminal();
const fitAddon = new FitAddon.FitAddon(); // 【【【 新增：建立 FitAddon 】】】

// --- 2. 【【【 關鍵修復：等待 DOM 載入完成 】】】 ---
// 
// 只有當 HTML 頁面完全載入並解析後，才執行裡面的所有 JS
document.addEventListener('DOMContentLoaded', (event) => {

    // --- A. 獲取所有 UI 元素 ---
    // (現在執行 getElementById 絕對安全)
    const termContainer = document.getElementById('terminal');
    term.loadAddon(fitAddon); // 【【【 新增：載入 Addon 】】】
    term.open(termContainer);

    const hostInput = document.getElementById('sshHost');
    const userInput = document.getElementById('sshUser');
    const connectBtn = document.getElementById('connectButton');
    const disconnectBtn = document.getElementById('disconnectButton');
    const commonHostsSelect = document.getElementById('commonHosts');

    // TMUX 元素
    const tmuxNewNameInput = document.getElementById('tmuxNewName');
    const tmuxNewBtn = document.getElementById('tmuxNewButton');
    const tmuxListBtn = document.getElementById('tmuxListButton');
    const tmuxListDiv = document.getElementById('tmux-window-list');
    const tmuxBar = document.getElementById('tmux-bar'); // 【【【 新增 】】】

    // --- B. 【【【 新的事件綁定 】】】 ---
    commonHostsSelect.addEventListener('change', selectCommonHost);
    connectBtn.addEventListener('click', connectSSH);
    disconnectBtn.addEventListener('click', disconnectSSH);
    
    tmuxNewBtn.addEventListener('click', tmuxNew);
    tmuxListBtn.addEventListener('click', tmuxList);

    // --- C. 初始化 UI 狀態 ---
    disconnectBtn.disabled = true;
    tmuxBar.classList.add('disabled'); // 【【【 新增：預設淡化 】】】

    // --- D. 綁定 Intereact.js (現在也是安全的) ---
    initializeWindowing();


    // --- E. 函數定義 (所有函數現在都在 DOMContentLoaded 內部) ---

    // --- Socket.IO 核心函數 ---
    function setupSocket() {
        if (socket) {
            socket.disconnect();
        }
        socket = io(); 

        socket.on('connect', () => {
            term.focus();
            tmuxList(); // 連線後自動列出
        });

        // 處理 xterm.js 重複綁定
        if (onDataListener) {
            onDataListener.dispose();
        }
        onDataListener = term.onData(e => {
            if (isConnected && socket) { 
                socket.emit('ssh_input', {input: e});
            }
        });

        // 監聽後端輸出
        socket.on('ssh_output', data => {
            term.write(data);
            if (data.includes('[Connection closed')) {
                setDisconnectedUI();
            }
            if (data.includes('[Already connected]')) {
                setConnectedUI(); 
            }
        });
        
        // 監聽 Socket 斷線 (例如網路問題)
        socket.on('disconnect', () => {
            if (isConnected) {
                term.write('\r\n\x1B[33m[Socket Disconnected]\x1B[0m\r\n');
                setDisconnectedUI();
            }
        });
        
        // 監聽 TMUX UI 更新
        socket.on('tmux_update', data => {
            tmuxListDiv.innerHTML = ''; // 清空列表
            
            if (data.windows && data.windows.length > 0) {
                data.windows.forEach(win => {
                    const btn = document.createElement('button');
                    btn.className = 'tmux-window-btn';
                    btn.textContent = `${win.id}: ${win.name}`;
                    // 點擊按鈕時，發送 "select" 指令
                    btn.onclick = () => tmuxSelect(win.id);
                    tmuxListDiv.appendChild(btn);
                });
            } else {
                tmuxListDiv.innerHTML = '<span>(No tmux windows found)</span>';
            }
        });
    }

    // --- 連線/斷線 函數 ---
    function connectSSH() {
        if (isConnected) {
            term.write('\r\n\x1B[31m[錯誤: 已經連線中，請先斷線後再試。]\x1B[0m\r\n');
            return;
        }
        
        const host = hostInput.value; 
        const user = userInput.value;
        
        if (!host || !user) {
            term.write('\r\n\x1B[31m[錯誤: Host 和 User 欄位皆為必填。]\x1B[0m\r\n');
            return;
        }

        setupSocket(); // 這會建立新 socket 並綁定所有監聽器
        setConnectedUI();
        term.reset(); 
        term.write(`Connecting to ${user}@${host}...\r\n`);
        socket.emit('ssh_connect', {host, user});
        term.focus();
    }

    function disconnectSSH() {
        if (socket) {
            socket.disconnect();
            socket = null; 
        }
        if (onDataListener) {
            onDataListener.dispose();
            onDataListener = null;
        }
        tmuxListDiv.innerHTML = ''; // 清空 tmux 列表
        term.write('\r\n\x1B[33m[User disconnected]\x1B[0m\r\n');
        setDisconnectedUI();
    }

    // --- 輔助函數 ---
    function selectCommonHost() {
        if (isConnected) return; 
        // commonHostsSelect 和 hostInput 都是安全的
        if(commonHostsSelect.value) {
            hostInput.value = commonHostsSelect.value;
        }
    }

    function setConnectedUI() {
        isConnected = true;
        hostInput.disabled = true;
        userInput.disabled = true;
        commonHostsSelect.disabled = true;
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        tmuxBar.classList.remove('disabled'); // 【【【 新增：啟用 tmux bar 】】】

        // 【【【 新增：連線後，立即 fit 一次 】】】
        // (需要一點延遲，確保 CSS 渲染完成)
        setTimeout(() => fitAddon.fit(), 100); 
    }

    function setDisconnectedUI() {
        isConnected = false;
        hostInput.disabled = false;
        userInput.disabled = false;
        commonHostsSelect.disabled = false;
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        tmuxBar.classList.add('disabled'); // 【【【 新增：禁用 tmux bar 】】】
    }

    // --- TMUX 函數 ---
    function tmuxList() {
        if (socket && isConnected) {
            socket.emit('tmux_control', { action: 'list' });
        }
    }

    function tmuxNew() {
        if (socket && isConnected) {
            const name = tmuxNewNameInput.value || 'new-window';
            socket.emit('tmux_control', { action: 'new', name: name });
            tmuxNewNameInput.value = ''; // 清空
        }
    }

    function tmuxSelect(targetId) {
        if (socket && isConnected) {
            socket.emit('tmux_control', { action: 'select', target: targetId });
            term.focus();
        }
    }
    
    // --- 視窗化函數 ---
    function initializeWindowing() {
        // 拖曳 (Draggable)
        interact('.draggable')
          .draggable({
            inertia: true,
            modifiers: [
              interact.modifiers.restrictRect({
                restriction: 'parent',
                endOnly: true
              })
            ],
            autoScroll: true,
            allowFrom: '.window-header', // D只能從 header 拖曳
            listeners: { move: dragMoveListener }
          });

        function dragMoveListener (event) {
          var target = event.target
          var x = (parseFloat(target.getAttribute('data-x')) || 0) + event.dx
          var y = (parseFloat(target.getAttribute('data-y')) || 0) + event.dy
          target.style.transform = 'translate(' + x + 'px, ' + y + 'px)'
          target.setAttribute('data-x', x)
          target.setAttribute('data-y', y)
        }

        // 縮放 (Resizable)
        interact('.resizable')
          .resizable({
            edges: { left: true, right: true, bottom: true, top: true },
            modifiers: [
              interact.modifiers.restrictEdges({ outer: 'parent' }),
              interact.modifiers.restrictSize({ min: { width: 400, height: 200 } })
            ],
            inertia: true
          })
          .on('resizemove', function (event) {
            var target = event.target
            var x = (parseFloat(target.getAttribute('data-x')) || 0)
            var y = (parseFloat(target.getAttribute('data-y')) || 0)

            target.style.width = event.rect.width + 'px'
            target.style.height = event.rect.height + 'px'

            x += event.deltaRect.left
            y += event.deltaRect.top
            target.style.transform = 'translate(' + x + 'px,' + y + 'px)'
            target.setAttribute('data-x', x)
            target.setAttribute('data-y', y)
            
            // 【【【 關鍵修復：替換 resize(1,1) 】】】
            // term.resize(1, 1); // <-- 刪除這一行
            
            // 【【【 改成呼叫 fitAddon.fit() 】】】
            // 這會讓 xterm 自動計算新的行列數
            fitAddon.fit();
          });
    }

}); // --- 【【【 關鍵修復：DOM Ready 事件結束 】】】 ---