// 檔案: static/js/script.js
// 
// 【【【 重構 12.0：修復「連線失敗時消失」的 Bug 】】】
//

// --- 1. 全域變數 ---
let isConnected = false;
let socket = null;
let globalZManager = 100;

let terminalInstances = {};
let activeTmuxTargets = {};

// Debounce 輔助函數 (不變)
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}


// --- 2. 【【【 DOM 載入完成 】】】 ---
document.addEventListener('DOMContentLoaded', (event) => {

    // --- A. 獲取【主控台】UI 元素 ---
    const masterTermContainer = document.getElementById('master-terminal');
    const masterWindowElement = document.getElementById('master-terminal-window');
    const mainTerm = new Terminal({ convertEol: true });
    const mainFitAddon = new FitAddon.FitAddon();
    mainTerm.loadAddon(mainFitAddon);
    mainTerm.open(masterTermContainer);
    
    terminalInstances['master'] = {
        term: mainTerm,
        fitAddon: mainFitAddon,
        element: masterWindowElement,
        target_id: 'master'
    };
    
    // (主控台的輸入綁定，不變)
    mainTerm.onData(e => {
        const masterInstance = Object.values(terminalInstances).find(inst => inst.target_id === 'master');
        if (isConnected && masterInstance && masterInstance.pty_id && socket) {
            socket.emit('pty_input', { pty_id: masterInstance.pty_id, input: e });
        }
    });

    // 獲取其他靜態 UI 元素 (不變)
    const hostInput = document.getElementById('sshHost');
    const userInput = document.getElementById('sshUser');
    const connectBtn = document.getElementById('connectButton');
    const disconnectBtn = document.getElementById('disconnectButton');
    const commonHostsSelect = document.getElementById('commonHosts');
    const tmuxNewNameInput = document.getElementById('tmuxNewName');
    const tmuxNewBtn = document.getElementById('tmuxNewButton');
    const tmuxListBtn = document.getElementById('tmuxListButton');
    const tmuxListDiv = document.getElementById('tmux-window-list');
    const tmuxBar = document.getElementById('tmux-bar'); 

    // (最小化按鈕邏輯，不變)
    const minimizeBtn = masterWindowElement.querySelector('.window-minimize-btn');
    let isMasterMinimized = false;
    let masterLastPosition = {}; 
    minimizeBtn.addEventListener('click', () => {
        isMasterMinimized = !isMasterMinimized;
        if (isMasterMinimized) {
            masterLastPosition = {
                width: masterWindowElement.style.width,
                height: masterWindowElement.style.height,
                transform: masterWindowElement.style.transform
            };
            masterWindowElement.classList.add('minimized');
            minimizeBtn.textContent = '+';
            interact(masterWindowElement).draggable(false).resizable(false);
            masterWindowElement.style.height = null; 
            masterWindowElement.style.width = null;
            const tmuxBarHeight = tmuxBar.getBoundingClientRect().height;
            masterWindowElement.style.bottom = (tmuxBarHeight + 5) + 'px';
        } else {
            masterWindowElement.classList.remove('minimized');
            minimizeBtn.textContent = '_';
            masterWindowElement.style.width = masterLastPosition.width;
            masterWindowElement.style.height = masterLastPosition.height;
            masterWindowElement.style.transform = masterLastPosition.transform;
            masterWindowElement.style.bottom = null;
            interact(masterWindowElement).draggable(true).resizable(true);
            setTimeout(() => mainFitAddon.fit(), 300); 
        }
    });

    // --- B. 綁定靜態事件 (不變) ---
    commonHostsSelect.addEventListener('change', selectCommonHost);
    connectBtn.addEventListener('click', connectSSH);
    disconnectBtn.addEventListener('click', disconnectSSH);
    tmuxNewBtn.addEventListener('click', tmuxNew);
    tmuxListBtn.addEventListener('click', tmuxList);

    // --- C. 初始化 UI 狀態 (不變) ---
    disconnectBtn.disabled = true;
    tmuxBar.classList.add('disabled');
    mainFitAddon.fit();

    // --- D. 綁定【主控台】的視窗化 (不變) ---
    initializeWindowing(masterWindowElement, mainFitAddon);


    // --- E. 函數定義 ---

    // --- Socket.IO 核心函數 ---
    function setupSocket() {
        if (socket) {
            socket.disconnect();
        }
        socket = io(); 

        socket.on('connect', () => {
            console.log('Socket connected, SID:', socket.id);
        });
        
        // (master_pty_created, 不變)
        socket.on('master_pty_created', (data) => {
            console.log('Master PTY created:', data.pty_id);
            const masterInstance = terminalInstances['master'];
            delete terminalInstances['master'];
            masterInstance.pty_id = data.pty_id;
            terminalInstances[data.pty_id] = masterInstance;
            mainTerm.focus();
            tmuxList();
        });

        // (sub_pty_created, 不變)
        socket.on('sub_pty_created', (data) => {
            console.log('Sub PTY created:', data);
            createDraggableWindow(data.pty_id, data.target_id, data.title);
        });

        // (pty_output, 不變)
        socket.on('pty_output', (data) => {
            const pty_id = data.pty_id;
            // 【【修改】】 確保 'master' key 也能被找到
            const instance = terminalInstances[pty_id] || (pty_id === 'master' ? terminalInstances['master'] : null);
            if (instance) {
                instance.term.write(data.data);
            } else {
                console.warn(`Received output for unknown PTY: ${pty_id}`);
            }
        });

        // (pty_closed, 不變)
        socket.on('pty_closed', (data) => {
            console.log('PTY closed by backend:', data.pty_id);
            cleanupWindow(data.pty_id);
        });
        
        // (disconnect, 不變)
        socket.on('disconnect', () => {
            console.log('Socket disconnected');
            setDisconnectedUI(); 
        });
        
        // (tmux_update, 不變)
        socket.on('tmux_update', (data) => {
            tmuxListDiv.innerHTML = ''; 
            if (data.windows && data.windows.length > 0) {
                data.windows.forEach(win => {
                    const btn = document.createElement('button');
                    btn.className = 'tmux-window-btn';
                    btn.textContent = `${win.id}: ${win.name}`;
                    btn.onclick = () => launchTmuxWindow(win.id, win.name);
                    tmuxListDiv.appendChild(btn);
                });
            } else {
                tmuxListDiv.innerHTML = '<span>(No tmux windows found)</span>';
            }
        });

        // 【【【 關鍵修復：監聽主 PTY 失敗事件 】】】
        socket.on('master_pty_failed', (data) => {
            console.warn("Master PTY failed to connect.", data.pty_id);
            // 重置 UI 到「未連線」狀態，但不清除已有的視窗
            isConnected = false;
            hostInput.disabled = false;
            userInput.disabled = false;
            commonHostsSelect.disabled = false;
            connectBtn.disabled = false;
            disconnectBtn.disabled = true; // 禁用斷線
            tmuxBar.classList.add('disabled'); // 禁用 tmux
            
            // 重置主控台的 pty_id
            const masterInstance = terminalInstances[data.pty_id];
            if (masterInstance) {
                 delete terminalInstances[data.pty_id];
                 masterInstance.pty_id = null;
                 terminalInstances['master'] = masterInstance;
            }
        });
    }

    // --- 連線/斷線 函數 (不變) ---
    function connectSSH() {
        if (isConnected) {
            mainTerm.write('\r\n\x1B[31m[錯誤: 已經連線中。]\x1B[0m\r\n');
            return;
        }
        const host = hostInput.value; 
        const user = userInput.value;
        if (!host || !user) {
            mainTerm.write('\r\n\x1B[31m[錯誤: Host 和 User 欄位皆為必填。]\x1B[0m\r\n');
            return;
        }
        setupSocket(); 
        setConnectedUI();
        mainTerm.reset(); 
        mainTerm.write(`Connecting to ${user}@${host}...\r\n`);
        socket.emit('ssh_connect', {host, user});
        mainTerm.focus();
    }

    function disconnectSSH() {
        if (socket) {
            socket.emit('ssh_disconnect');
        }
    }

    // --- 輔助函數 (setConnectedUI, setDisconnectedUI 修改) ---
    function selectCommonHost() {
        if (isConnected) return; 
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
        tmuxBar.classList.remove('disabled');
        setTimeout(() => mainFitAddon.fit(), 100); 
    }

    function setDisconnectedUI() {
        isConnected = false;
        
        // 關閉所有動態視窗
        const all_pty_ids = Object.keys(terminalInstances);
        for (const pty_id of all_pty_ids) {
            const instance = terminalInstances[pty_id];
            if (instance && instance.target_id !== 'master') {
                instance.term.dispose();
                instance.element.remove();
                // delete terminalInstances[pty_id]; // (cleanupWindow 會處理)
            }
        }
        
        // 【【修改】】 重置主控台實例
        const masterInstance = Object.values(terminalInstances).find(inst => inst.target_id === 'master');
        terminalInstances = {}; // 清空
        if (masterInstance) {
             if (masterInstance.pty_id) {
                 delete terminalInstances[masterInstance.pty_id];
             }
             masterInstance.pty_id = null;
             terminalInstances['master'] = masterInstance;
        }
        
        activeTmuxTargets = {}; // 清空 tmux 查找表

        hostInput.disabled = false;
        userInput.disabled = false;
        commonHostsSelect.disabled = false;
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        tmuxBar.classList.add('disabled');
        tmuxListDiv.innerHTML = ''; 
        mainTerm.write('\r\n\x1B[33m[All connections closed]\x1B[0m\r\n');
    }

    // --- TMUX 函數 (不變) ---
    function tmuxList() {
        if (socket && isConnected) {
            socket.emit('tmux_control', { action: 'list' });
        }
    }
    function tmuxNew() {
        if (socket && isConnected) {
            const name = tmuxNewNameInput.value || 'new-window';
            socket.emit('tmux_control', { action: 'new', name: name });
            tmuxNewNameInput.value = '';
        }
    }

    // --- MDI 視窗管理 (不變) ---
    
    function launchTmuxWindow(target_id, title) {
        const pty_id = activeTmuxTargets[target_id];
        if (pty_id && terminalInstances[pty_id]) {
            focusWindow(terminalInstances[pty_id].element);
        } else {
            mainTerm.write(`\r\n[Requesting PTY for ${title} (${target_id})...]\r\n`);
            socket.emit('tmux_attach', { 
                target_id: target_id, 
                title: title 
            });
        }
    }

    function createDraggableWindow(pty_id, target_id, title) {
        const windowEl = document.createElement('div');
        windowEl.className = 'terminal-window dynamic-terminal-window';
        
        const x = 60 + (Math.random() * 200);
        const y = 60 + (Math.random() * 200);
        windowEl.style.transform = `translate(${x}px, ${y}px)`;
        windowEl.setAttribute('data-x', x);
        windowEl.setAttribute('data-y', y);

        windowEl.innerHTML = `
            <header class="window-header">
                <span class="window-title">${target_id}: ${title}</span>
                <button class="window-close-btn" aria-label="Close"></button>
            </header>
            <div class="terminal-container"></div>
        `;
        
        const termContainer = windowEl.querySelector('.terminal-container');
        document.body.appendChild(windowEl);
        
        const newTerm = new Terminal({ convertEol: true, rows: 15 });
        const newFitAddon = new FitAddon.FitAddon();
        newTerm.loadAddon(newFitAddon);
        newTerm.open(termContainer);
        newFitAddon.fit();
        newTerm.focus();

        newTerm.onData(e => {
            if (socket) {
                socket.emit('pty_input', { pty_id: pty_id, input: e });
            }
        });
        
        windowEl.querySelector('.window-close-btn').addEventListener('click', () => {
            if (socket) {
                socket.emit('pty_close', { pty_id: pty_id });
            }
            cleanupWindow(pty_id);
        });

        terminalInstances[pty_id] = {
            term: newTerm,
            fitAddon: newFitAddon,
            element: windowEl,
            target_id: target_id
        };
        activeTmuxTargets[target_id] = pty_id;

        initializeWindowing(windowEl, newFitAddon);
        focusWindow(windowEl);
    }
    
    function cleanupWindow(pty_id) {
        const instance = terminalInstances[pty_id];
        if (instance) {
            instance.term.dispose();
            instance.element.remove();
            delete activeTmuxTargets[instance.target_id];
            delete terminalInstances[pty_id];
        }
    }
    
    function focusWindow(element) {
        if (element.id === 'master-terminal-window' && isMasterMinimized) {
            minimizeBtn.click();
        }
        element.style.zIndex = globalZManager++;
    }

    // --- 視窗化 (Debounce 修復, 不變) ---
    function initializeWindowing(element, fitAddon) {
        
        const debouncedFit = debounce(() => {
            if (fitAddon && typeof fitAddon.fit === 'function') {
                fitAddon.fit();
            }
        }, 150);

        element.addEventListener('mousedown', () => {
            focusWindow(element);
        }, true);

        interact(element)
          .draggable({
            inertia: true,
            modifiers: [
              interact.modifiers.restrictRect({
                restriction: 'parent',
                endOnly: true
              })
            ],
            autoScroll: true,
            allowFrom: '.window-header',
            listeners: { 
                start: (e) => focusWindow(e.target),
                move: dragMoveListener 
            }
          });

        function dragMoveListener (event) {
          var target = event.target
          if(target.classList.contains('minimized')) return;
          var x = (parseFloat(target.getAttribute('data-x')) || 0) + event.dx
          var y = (parseFloat(target.getAttribute('data-y')) || 0) + event.dy
          target.style.transform = 'translate(' + x + 'px, ' + y + 'px)'
          target.setAttribute('data-x', x)
          target.setAttribute('data-y', y)
        }

        interact(element)
          .resizable({
            edges: { left: true, right: true, bottom: true, top: true },
            modifiers: [
              interact.modifiers.restrictEdges({ outer: 'parent' }),
              interact.modifiers.restrictSize({ min: { width: 400, height: 200 } })
            ],
            inertia: true,
            listeners: {
                start: (e) => focusWindow(e.target)
            }
          })
          .on('resizemove', function (event) {
            var target = event.target
            if(target.classList.contains('minimized')) return;

            var x = (parseFloat(target.getAttribute('data-x')) || 0)
            var y = (parseFloat(target.getAttribute('data-y')) || 0)

            target.style.width = event.rect.width + 'px'
            target.style.height = event.rect.height + 'px'

            x += event.deltaRect.left
            y += event.deltaRect.top
            target.style.transform = 'translate(' + x + 'px,' + y + 'px)'
            target.setAttribute('data-x', x)
            target.setAttribute('data-y', y)
            
            debouncedFit();
          });
    }

}); // --- 【【【 DOM Ready 事件結束 】】】 ---