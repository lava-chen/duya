// DUYA Browser Bridge - Popup Script

const DAEMON_URL = 'http://127.0.0.1:19825';

function setState(state, label, detail) {
  const statusCard = document.getElementById('statusCard');
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');
  const statusDetail = document.getElementById('statusDetail');

  statusCard.className = 'status-card ' + state;
  statusDot.className = 'status-dot ' + state;
  statusLabel.textContent = label;
  if (detail !== undefined) {
    statusDetail.textContent = detail;
  }
}

async function checkStatus() {
  setState('checking', 'Checking...', 'Connecting to daemon');

  try {
    const resp = await fetch(DAEMON_URL + '/ping');
    if (!resp.ok) throw new Error('Daemon returned ' + resp.status);
    const data = await resp.json();

    if (data.extensionConnected) {
      const extVer = data.extensionVersion || '?';
      setState('connected', 'Connected', 'Bridge v' + extVer + ' active');
    } else {
      setState('disconnected', 'Not Connected', 'Daemon running, bridge offline');
    }
  } catch {
    setState('disconnected', 'Daemon Offline', 'Start DUYA desktop app first');
  }
}

function initUI() {
  var manifest = chrome.runtime.getManifest();
  document.getElementById('titleName').textContent = manifest.name;
  document.getElementById('titleVersion').textContent = 'v' + manifest.version;

  document.getElementById('connectBtn').addEventListener('click', async function () {
    setState('checking', 'Connecting...', 'Triggering reconnect');
    await chrome.runtime.sendMessage({ type: 'connect' });
    await new Promise(function (r) { return setTimeout(r, 800); });
    await checkStatus();
  });

  document.getElementById('settingsBtn').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('openApp').addEventListener('click', function () {
    window.open('duya://open', '_blank');
  });
}

initUI();
checkStatus();