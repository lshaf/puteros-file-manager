#!/usr/bin/env node
//
// Generates a synthetic WPA2-PSK 4-way-handshake pcap that the interface's
// crack flow (interface/index.js, _CRACK_WORKER_SRC) can parse and crack.
//
// Writes:
//   sandbox/<bssid>_TestNet.pcap
//   sandbox/unigeek/utility/passwords/sample.dict   (contains the password)
//
// The pcap holds:
//   * one beacon frame    – so the parser picks up the SSID without filename tricks
//   * M1 (AP→STA)         – ACK=1, MIC=0, carries ANonce
//   * M2 (STA→AP)         – ACK=0, MIC=1, carries SNonce + a real MIC
//
// MIC is computed with the exact same PRF the cracker uses
// (HMAC-SHA1(PMK, "Pairwise key expansion\0" || prf_data || 0x00)[0:16] = KCK,
//  then HMAC-SHA1(KCK, m2_eapol_with_mic_zeroed)[0:16] = MIC).

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── parameters ───────────────────────────────────────────────────────────
const PROJECT = path.resolve(__dirname, '..');
const SANDBOX = path.join(PROJECT, 'sandbox');

const SSID     = 'TestNet';
const PASSWORD = 'password123';
const AP_BSSID = Buffer.from([0xAA, 0xBB, 0xCC, 0x11, 0x22, 0x33]);
const STA_MAC  = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01]);
const ANONCE   = crypto.randomBytes(32);
const SNONCE   = crypto.randomBytes(32);
const REPLAY   = Buffer.from([0,0,0,0,0,0,0,1]);

// ── crypto helpers ───────────────────────────────────────────────────────
function deriveKCK(password, ssid, ap, sta, anonce, snonce) {
    const pmk = crypto.pbkdf2Sync(password, ssid, 4096, 32, 'sha1');
    // prf_data = min(ap,sta)||max(ap,sta) || min(anonce,snonce)||max(anonce,snonce)
    const prfData = Buffer.alloc(76);
    if (Buffer.compare(ap, sta) < 0) { ap.copy(prfData, 0); sta.copy(prfData, 6); }
    else                              { sta.copy(prfData, 0); ap.copy(prfData, 6); }
    if (Buffer.compare(anonce, snonce) < 0) { anonce.copy(prfData, 12); snonce.copy(prfData, 44); }
    else                                     { snonce.copy(prfData, 12); anonce.copy(prfData, 44); }
    const label = Buffer.from('Pairwise key expansion\0', 'binary');     // 23 bytes
    const input = Buffer.concat([label, prfData, Buffer.from([0])]);     // 100 bytes
    return crypto.createHmac('sha1', pmk).update(input).digest().subarray(0, 16);
}

// ── 802.11 / EAPOL builders ──────────────────────────────────────────────
const LLC_SNAP_EAPOL = Buffer.from([0xAA, 0xAA, 0x03, 0x00, 0x00, 0x00, 0x88, 0x8E]);

function eapolKeyFrame(keyInfo, replay, nonce, mic) {
    // 4-byte EAPOL header + 95-byte key descriptor = 99 bytes total.
    const buf = Buffer.alloc(99);
    buf[0] = 0x02;                                  // version
    buf[1] = 0x03;                                  // EAPOL-Key
    buf.writeUInt16BE(95, 2);                       // body length
    buf[4] = 0x02;                                  // descriptor type (RSN)
    buf.writeUInt16BE(keyInfo, 5);                  // key info
    buf.writeUInt16BE(16, 7);                       // key length (CCMP)
    replay.copy(buf, 9);                            // replay counter (8)
    nonce.copy(buf, 17);                            // key nonce (32)
    // key IV   16 bytes @49..64 → zeros
    // key RSC   8 bytes @65..72 → zeros
    // key ID    8 bytes @73..80 → zeros
    if (mic) mic.copy(buf, 81);                     // key MIC (16) @81..96
    // key data length 2 bytes @97..98 → zeros (no key data)
    return buf;
}

function dot11Data(a1, a2, a3, eapol) {
    const hdr = Buffer.alloc(24);
    hdr[0] = 0x08; hdr[1] = 0x00;     // data frame, subtype 0, no DS flags
    a1.copy(hdr, 4);                  // Addr1
    a2.copy(hdr, 10);                 // Addr2
    a3.copy(hdr, 16);                 // Addr3
    return Buffer.concat([hdr, LLC_SNAP_EAPOL, eapol]);
}

function dot11Beacon(bssid, ssid) {
    const hdr = Buffer.alloc(24);
    hdr[0] = 0x80; hdr[1] = 0x00;     // beacon
    Buffer.from([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF]).copy(hdr, 4);
    bssid.copy(hdr, 10);
    bssid.copy(hdr, 16);
    hdr[22] = 0x10;                    // seq lo nibble
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16LE(100, 8);       // beacon interval
    fixed.writeUInt16LE(0x0011, 10);   // capability: ESS + privacy
    const ssidBytes = Buffer.from(ssid, 'utf8');
    const ssidTag = Buffer.concat([Buffer.from([0, ssidBytes.length]), ssidBytes]);
    // tag 1 (supported rates) — present in real beacons, parser ignores
    const ratesTag = Buffer.from([0x01, 0x08, 0x82, 0x84, 0x8B, 0x96, 0x0C, 0x12, 0x18, 0x24]);
    return Buffer.concat([hdr, fixed, ssidTag, ratesTag]);
}

// ── pcap wrappers ────────────────────────────────────────────────────────
function pcapRecord(frame, sec, usec) {
    const hdr = Buffer.alloc(16);
    hdr.writeUInt32LE(sec,           0);
    hdr.writeUInt32LE(usec,          4);
    hdr.writeUInt32LE(frame.length,  8);
    hdr.writeUInt32LE(frame.length, 12);
    return Buffer.concat([hdr, frame]);
}

function pcapGlobalHeader() {
    const hdr = Buffer.alloc(24);
    hdr.writeUInt32LE(0xa1b2c3d4, 0);
    hdr.writeUInt16LE(2, 4);
    hdr.writeUInt16LE(4, 6);
    hdr.writeInt32LE (0, 8);
    hdr.writeUInt32LE(0, 12);
    hdr.writeUInt32LE(65535, 16);
    hdr.writeUInt32LE(105,   20);   // DLT_IEEE802_11
    return hdr;
}

// ── compose ──────────────────────────────────────────────────────────────
const KCK = deriveKCK(PASSWORD, SSID, AP_BSSID, STA_MAC, ANONCE, SNONCE);

// M1: AP→STA, ACK=1, MIC=0  →  key info 0x008A
const m1Eapol = eapolKeyFrame(0x008A, REPLAY, ANONCE, null);
const m1Frame = dot11Data(STA_MAC, AP_BSSID, AP_BSSID, m1Eapol);

// M2: STA→AP, ACK=0, MIC=1  →  key info 0x010A
const m2EapolZero = eapolKeyFrame(0x010A, REPLAY, SNONCE, null);
const mic         = crypto.createHmac('sha1', KCK).update(m2EapolZero).digest().subarray(0, 16);
const m2Eapol     = eapolKeyFrame(0x010A, REPLAY, SNONCE, mic);
const m2Frame     = dot11Data(AP_BSSID, STA_MAC, AP_BSSID, m2Eapol);

const beacon = dot11Beacon(AP_BSSID, SSID);

const pcap = Buffer.concat([
    pcapGlobalHeader(),
    pcapRecord(beacon,  1700000000,   0),
    pcapRecord(m1Frame, 1700000001, 100),
    pcapRecord(m2Frame, 1700000001, 250),
]);

// ── write outputs ────────────────────────────────────────────────────────
fs.mkdirSync(SANDBOX, { recursive: true });
const bssidHex = Array.from(AP_BSSID).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
const pcapName = `${bssidHex}_${SSID}.pcap`;
const pcapPath = path.join(SANDBOX, pcapName);
fs.writeFileSync(pcapPath, pcap);

const dictDir = path.join(SANDBOX, 'unigeek/utility/passwords');
fs.mkdirSync(dictDir, { recursive: true });
const dictPath = path.join(dictDir, 'sample.dict');
fs.writeFileSync(dictPath, [
    '12345678',
    'qwertyui',
    'password',
    'letmein123',
    'iloveyou1',
    'abc12345',
    PASSWORD,                     // ← the correct one
    'zzzzzzzz',
].join('\n') + '\n');

console.log('wrote:', pcapPath, `(${pcap.length} bytes)`);
console.log('wrote:', dictPath);
console.log();
console.log('ssid     :', SSID);
console.log('password :', PASSWORD);
console.log('ap bssid :', bssidHex);
console.log();
console.log('try it:   log in → click ⚡ on the .pcap → pick "sample.dict" → crack');
