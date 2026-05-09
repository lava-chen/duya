// DUYA Browser Bridge - Options Page Script
// Manages blocked domains list

var STORAGE_KEY = 'duyaBlockedDomains';

var blockedDomains = [];

// Load blocked domains from storage
async function loadDomains() {
  try {
    var result = await chrome.storage.local.get(STORAGE_KEY);
    blockedDomains = result[STORAGE_KEY] || [];
    renderDomains();
  } catch (error) {
    showStatus('Failed to load domains: ' + error.message, 'error');
  }
}

// Save blocked domains to storage
async function saveDomains() {
  try {
    var data = {};
    data[STORAGE_KEY] = blockedDomains;
    await chrome.storage.local.set(data);
    return true;
  } catch (error) {
    showStatus('Failed to save domains: ' + error.message, 'error');
    return false;
  }
}

// Render the domain list
function renderDomains() {
  var listEl = document.getElementById('domainList');

  if (blockedDomains.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No blocked domains</div>';
    return;
  }

  listEl.innerHTML = blockedDomains.map(function (domain, index) {
    return (
      '<div class="domain-item">' +
        '<span class="domain-text">' + escapeHtml(domain) + '</span>' +
        '<button class="domain-remove" data-index="' + index + '">Remove</button>' +
      '</div>'
    );
  }).join('');

  listEl.querySelectorAll('.domain-remove').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var index = parseInt(btn.dataset.index, 10);
      removeDomain(index);
    });
  });
}

// Add a new domain
async function addDomain() {
  var input = document.getElementById('newDomain');
  var raw = input.value.trim();
  var domain = normalizeDomain(raw);

  if (!domain) {
    showStatus('Please enter a valid domain (e.g., example.com)', 'error');
    return;
  }

  if (!isValidDomain(domain)) {
    showStatus('Invalid domain format. Use format like: example.com', 'error');
    return;
  }

  if (blockedDomains.indexOf(domain) !== -1) {
    showStatus('This domain is already blocked', 'error');
    return;
  }

  blockedDomains.push(domain);
  blockedDomains.sort();

  if (await saveDomains()) {
    input.value = '';
    renderDomains();
    showStatus('Domain added successfully', 'success');
  }
}

// Remove a domain
async function removeDomain(index) {
  blockedDomains.splice(index, 1);

  if (await saveDomains()) {
    renderDomains();
    showStatus('Domain removed successfully', 'success');
  }
}

// Validate domain format
function isValidDomain(domain) {
  var domainPattern = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
  return domainPattern.test(domain);
}

// Extract domain from input (handles URLs, strips www)
function normalizeDomain(input) {
  var domain = input.trim().toLowerCase();

  if (domain.indexOf('http://') === 0 || domain.indexOf('https://') === 0) {
    try {
      domain = new URL(domain).hostname;
    } catch (_e) {
      return null;
    }
  }

  if (domain.indexOf('www.') === 0) {
    domain = domain.slice(4);
  }

  return domain;
}

// Show status message
function showStatus(message, type) {
  var statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = 'status ' + type;

  clearTimeout(statusEl._timer);
  statusEl._timer = setTimeout(function () {
    statusEl.className = 'status';
  }, 3000);
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', function () {
  var manifest = chrome.runtime.getManifest();
  document.getElementById('versionInfo').textContent = manifest.name + ' v' + manifest.version;

  loadDomains();

  var addBtn = document.getElementById('addBtn');
  var input = document.getElementById('newDomain');

  addBtn.addEventListener('click', addDomain);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDomain();
    }
  });
});