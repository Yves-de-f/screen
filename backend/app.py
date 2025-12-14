import os
import pty
import signal
import jwt
import subprocess
import shlex
import tempfile
import uuid
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, render_template, request, jsonify, redirect, url_for, make_response
from flask_socketio import SocketIO
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__, template_folder='../templates', static_folder='../static')
app.config['SECRET_KEY'] = 'a_very_secret_key'
socketio = SocketIO(app, async_mode='threading')

# --- User Store (不變) ---
USERS = {
    "yves": generate_password_hash("123")
}

# --- JWT & Auth (不變) ---
def generate_token(username):
    payload = {
        'exp': datetime.utcnow() + timedelta(hours=1),
        'iat': datetime.utcnow(),
        'sub': username
    }
    return jwt.encode(payload, app.config['SECRET_KEY'], algorithm='HS256')

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.cookies.get('token')
        if not token:
            return redirect(url_for('login'))
        try:
            jwt.decode(token, app.config['SECRET_KEY'], algorithms=['HS256'])
        except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
            return redirect(url_for('login', error='Invalid or expired token.'))
        return f(*args, **kwargs)
    return decorated

# --- Routes (不變) ---
@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        user_hash = USERS.get(username)
        if user_hash and check_password_hash(user_hash, password):
            token = generate_token(username)
            resp = jsonify({'token': token})
            resp.set_cookie('token', token, httponly=True, samesite='Lax')
            return resp
        return jsonify({'error': 'Invalid credentials'}), 401
    error = request.args.get('error')
    return render_template('login.html', error=error)

@app.route('/logout')
def logout():
    resp = make_response(redirect(url_for('login')))
    resp.set_cookie('token', '', expires=0)
    return resp

@app.route('/')
@token_required
def index():
    return render_template('index.html')

# --- 【【【 架構變更：SSH / PTY 管理 】】】 ---

ssh_connections = {}
pty_sessions = {}
ALLOWED_HOSTS = {
    "twnia3.nchc.org.tw",
    "其他節點1",
}

def read_and_forward_ssh_output(sid, pty_id):
    """(不變)"""
    print(f"Read task starting for PTY {pty_id} (SID {sid})...")
    
    try:
        fd = pty_sessions[pty_id]['fd']
    except KeyError:
        print(f"Read task for {pty_id} started, but session already gone.")
        return

    while True:
        if pty_id not in pty_sessions:
            print(f"Read task for {pty_id} stopping (session removed).")
            break
        
        try:
            output = os.read(fd, 1024)
            if output:
                socketio.emit('pty_output', {
                    'pty_id': pty_id,
                    'data': output.decode(errors='replace')
                }, to=sid)
            else:
                print(f"Read task for {pty_id} got EOF (process exited).")
                break
        except (OSError, KeyError):
            print(f"Read task for {pty_id} stopping (OS/KeyError).")
            break
    
    print(f"Read task for {pty_id} finished. Requesting cleanup.")
    
    is_master = False
    if sid in ssh_connections and ssh_connections[sid]['master_pty_id'] == pty_id:
        is_master = True

    cleanup_pty_session(pty_id) 

    if is_master:
        socketio.emit('pty_output', {
            'pty_id': pty_id,
            'data': '\r\n[SSH Process Exited. Connection Failed or Refused.]\r\n'
        }, to=sid)
        socketio.emit('master_pty_failed', {'pty_id': pty_id}, to=sid)
    else:
        socketio.emit('pty_closed', {'pty_id': pty_id}, to=sid)


def cleanup_pty_session(pty_id):
    """(不變)"""
    session = pty_sessions.pop(pty_id, None)
    
    if not session:
        return

    pid = session.get('pid')
    fd = session.get('fd')
    
    print(f"Cleanup: Performing cleanup for PTY {pty_id} (PID {pid})")
    
    try:
        os.write(fd, b'\x03') # Ctrl+C
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass
        
    print(f"Cleanup: Successfully cleaned up PTY {pty_id} (PID {pid})")


@socketio.on('connect')
def on_connect():
    """(不變)"""
    token = request.cookies.get('token') 
    if not token:
        print("Client connected without token. Disconnecting.")
        return False
    try:
        jwt.decode(token, app.config['SECRET_KEY'], algorithms=['HS256'])
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        print("Client connected with invalid token. Disconnecting.")
        return False

@socketio.on('disconnect')
def on_disconnect():
    """(不變)"""
    sid = request.sid
    print(f"Client {sid} disconnected (SocketIO).")
    
    all_ptys = list(pty_sessions.keys())
    for pty_id in all_ptys:
        if pty_sessions.get(pty_id, {}).get('sid') == sid:
            cleanup_pty_session(pty_id)
    
    connection = ssh_connections.pop(sid, None)
    if connection:
        ctrl_path = connection.get('ctrl_path')
        if ctrl_path:
            try:
                exit_cmd = ['ssh', '-S', ctrl_path, '-O', 'exit', 'ignored']
                subprocess.run(exit_cmd, timeout=5)
                print(f"Cleanup: Closed master connection for {sid}")
                if os.path.exists(ctrl_path):
                     os.remove(ctrl_path)
            except Exception as e:
                print(f"Cleanup: Error closing master connection: {e}")

@socketio.on('ssh_connect')
def ssh_connect(data):
    """(不變)"""
    sid = request.sid
    if sid in ssh_connections:
        socketio.emit('pty_output', {'pty_id': 'master', 'data': '\r\n[Already connected]\r\n'}, to=sid)
        return

    host = data.get('host')
    user = data.get('user')

    if not host or not user or host not in ALLOWED_HOSTS:
        socketio.emit('pty_output', {'pty_id': 'master', 'data': f"\r\n[Error: Invalid host or user]\r\n"}, to=sid)
        return

    try:
        with tempfile.NamedTemporaryFile(delete=True) as tmp_file:
            ctrl_path = tmp_file.name
    except Exception as e:
        socketio.emit('pty_output', {'pty_id': 'master', 'data': f'\r\n[Error creating temp socket path: {e}]\r\n'}, to=sid)
        return

    command = ['ssh', '-M', '-S', ctrl_path, f'{user}@{host}']
    master_pty_id = f"{sid}-master" 

    try:
        pid, fd = pty.fork()
    except OSError as e:
        socketio.emit('pty_output', {'pty_id': 'master', 'data': f'\r\n[Error forking pty: {e}]\r\n'}, to=sid)
        return

    if pid == 0:  # Child process
        os.execvp(command[0], command)
    else:  # Parent process
        print(f"Started Master SSH process with PID {pid} for SID {sid}")
        print(f"Control Socket at: {ctrl_path}")
        
        ssh_connections[sid] = {
            'user': user,
            'host': host,
            'ctrl_path': ctrl_path,
            'master_pty_id': master_pty_id
        }
        pty_sessions[master_pty_id] = {
            'sid': sid,
            'pid': pid, 
            'fd': fd
        }
        
        socketio.start_background_task(target=read_and_forward_ssh_output, sid=sid, pty_id=master_pty_id)
        
        socketio.emit('master_pty_created', {'pty_id': master_pty_id}, to=sid)

@socketio.on('pty_input')
def pty_input(data):
    """(不變)"""
    pty_id = data.get('pty_id')
    session = pty_sessions.get(pty_id)
    if session:
        try:
            os.write(session['fd'], data['input'].encode())
        except OSError:
            pass

@socketio.on('pty_close')
def pty_close(data):
    """(不變)"""
    pty_id = data.get('pty_id')
    if pty_id:
        print(f"Client requested close for PTY {pty_id}")
        cleanup_pty_session(pty_id) 


@socketio.on('ssh_disconnect')
def ssh_disconnect():
    """(不變)"""
    sid = request.sid
    print(f"Client {sid} requested full disconnect.")
    socketio.disconnect(sid) 


# --- TMUX 控制器 (不變) ---

def run_ssh_control_command(sid, tmux_command):
    """(不變)"""
    connection = ssh_connections.get(sid)
    if not connection:
        return {"error": "Session not found"}

    ctrl_path = connection['ctrl_path']
    if not os.path.exists(ctrl_path):
         return {"error": f"Control socket {ctrl_path} not found"}

    ssh_cmd = ['ssh', '-S', ctrl_path, '-o', 'BatchMode=yes', 'ignored_host', tmux_command]

    try:
        process = subprocess.Popen(ssh_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = process.communicate(timeout=10)
        if process.returncode != 0:
            return {"error": stderr.strip() or f"Command failed with code {process.returncode}"}
        return {"output": stdout.strip()}
    except subprocess.TimeoutExpired:
        process.kill()
        return {"error": "SSH control command timed out"}
    except Exception as e:
        return {"error": f"SSH control command exception: {e}"}

@socketio.on('tmux_control')
def tmux_control(data):
    """(不變)"""
    sid = request.sid
    action = data.get('action')
    if not action:
        return

    tmux_base_cmd = "tmux start-server ; (tmux has-session 2>/dev/null || tmux new-session -d) && "
    tmux_command = ""

    if action == 'list':
        tmux_command = "tmux list-windows -F '#{window_id}:#{window_name}'"
    
    elif action == 'new':
        name = data.get('name', '').strip()
        if not name:
            list_cmd = tmux_base_cmd + "tmux list-windows -F '#{window_name}'"
            list_result = run_ssh_control_command(sid, list_cmd)
            existing_names = []
            if "output" in list_result and list_result['output']:
                existing_names = list_result['output'].split('\n')
            numeric_names = set()
            for n in existing_names:
                if n.isdigit():
                    numeric_names.add(int(n))
            new_name_int = 0
            while new_name_int in numeric_names:
                new_name_int += 1
            name = str(new_name_int)
        tmux_command = f"tmux new-window -n {shlex.quote(name)} -d -P -F '#{{window_id}}:#{{window_name}}'"
        
    elif action == 'select':
        pass
        
    else:
        return

    full_command = tmux_base_cmd + tmux_command
    result = run_ssh_control_command(sid, full_command)

    master_pty_id = ssh_connections.get(sid, {}).get('master_pty_id', 'master')
    
    if "error" in result and result['error']:
        err_msg = result['error']
        if "no server" in err_msg or "no session" in err_msg:
             if action != 'list':
                 tmux_control({'action': 'list'})
             return
        socketio.emit('pty_output', {'pty_id': master_pty_id, 'data': f"\r\n[TMUX Error: {err_msg}]\r\n"}, to=sid)
        return

    if action == 'list':
        windows = []
        if result['output']:
            try:
                for line in result['output'].split('\n'):
                    parts = line.split(':', 1)
                    if len(parts) == 2:
                        windows.append({"id": parts[0], "name": parts[1]})
            except Exception as e:
                socketio.emit('pty_output', {'pty_id': master_pty_id, 'data': f"\r\n[TMUX Parse Error: {e}]\r\n"}, to=sid)
        socketio.emit('tmux_update', {"windows": windows}, to=sid)

    elif action == 'new':
        socketio.emit('pty_output', {'pty_id': master_pty_id, 'data': f"\r\n[TMUX: Created {result.get('output')}]\r\n"}, to=sid)
        tmux_control({'action': 'list'})


@socketio.on('tmux_attach')
def tmux_attach(data):
    """
    【【【 關鍵修復：加入 '-t' 參數 】】】
    """
    sid = request.sid
    connection = ssh_connections.get(sid)
    if not connection:
        return

    target_id = data.get('target_id')
    if not target_id:
        return

    pty_id = f"{sid}-{target_id}"

    if pty_id in pty_sessions:
        print(f"PTY {pty_id} already running.")
        return

    ctrl_path = connection['ctrl_path']
    command_str = f"tmux attach-session -t {shlex.quote(target_id)}"
    
    # 【【【 關鍵修復：加入 '-t' 來強制 TTY 分配 】】】
    command = ['ssh', '-S', ctrl_path, 'ignored_host', '-t', command_str]

    try:
        pid, fd = pty.fork()
    except OSError as e:
        master_pty_id = connection.get('master_pty_id', 'master')
        socketio.emit('pty_output', {'pty_id': master_pty_id, 'data': f'\r\n[Error forking PTY for {target_id}: {e}]\r\n'}, to=sid)
        return

    if pid == 0:  # Child process
        os.execvp(command[0], command)
    else:  # Parent process
        print(f"Started Sub-PTY {pty_id} (PID {pid}) attached to {target_id}")
        
        pty_sessions[pty_id] = {
            'sid': sid,
            'pid': pid, 
            'fd': fd
        }
        
        socketio.start_background_task(target=read_and_forward_ssh_output, sid=sid, pty_id=pty_id)
        
        socketio.emit('sub_pty_created', {
            'pty_id': pty_id,
            'target_id': target_id,
            'title': data.get('title', target_id)
        }, to=sid)

if __name__ == '__main__':
    print("Starting SSH Web Terminal server on http://0.0.0.0:5500")
    socketio.run(app, host='0.0.0.0', port=5500, debug=True)