/**
 * Spike P2P (UT-026) — xác minh ICE + DataChannel trên HTTP LAN.
 *
 * Trang này CỐ Ý không dùng bất kỳ module nào của app và không gọi API của server: nó chỉ
 * cần biết trình duyệt có thiết lập được kết nối trực tiếp trên origin HTTP LAN hay không.
 * Vì vậy nó không phụ thuộc vào signaling của ta và có thể chạy trước khi M5 được thi công.
 *
 * Lưu ý môi trường: trên origin không bảo mật, `crypto.subtle` KHÔNG tồn tại, nên phần kiểm
 * tra dữ liệu ở đây dùng FNV-1a 32-bit tự viết — chỉ để phát hiện lệch byte, không phải bảo mật.
 * (App thật đã tránh vấn đề này bằng cách dùng SHA-256 incremental pure-JS trong utils.js.)
 */

const ICE_WAIT_MS = 8000;
const TEST_SIZE = 1024 * 1024;
const FRAME_SIZE = 64 * 1024;
const BUFFER_HIGH = 512 * 1024;
const BUFFER_LOW = 128 * 1024;

const el = (id) => document.getElementById(id);

function log(message, cls = '') {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  const node = document.createElement('div');
  if (cls) node.className = cls;
  node.textContent = line;
  el('log').appendChild(node);
  el('log').scrollTop = el('log').scrollHeight;
}

function row(table, label, value, cls = '') {
  const tr = document.createElement('tr');
  const th = document.createElement('td');
  th.textContent = label;
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = value;
  tr.append(th, td);
  table.appendChild(tr);
  return td;
}

const stateFields = {};
function setState(label, value, cls = '') {
  if (!stateFields[label]) stateFields[label] = row(el('state'), label, '—');
  stateFields[label].textContent = value;
  stateFields[label].className = cls;
}

// ---------------------------------------------------------------- môi trường

function reportEnvironment() {
  const table = el('env');
  const hasPc = typeof window.RTCPeerConnection === 'function';
  row(table, 'RTCPeerConnection', hasPc ? 'có' : 'KHÔNG CÓ', hasPc ? 'ok' : 'bad');
  row(
    table,
    'RTCDataChannel',
    typeof window.RTCDataChannel === 'function' ? 'có' : 'không có lớp constructor'
  );
  row(table, 'isSecureContext', String(window.isSecureContext));
  row(
    table,
    'crypto.subtle',
    typeof crypto?.subtle === 'object' ? 'có' : 'KHÔNG CÓ (bình thường trên HTTP)'
  );
  row(table, 'origin', location.origin);
  row(table, 'user agent', navigator.userAgent);
  if (!hasPc) {
    log('Không có RTCPeerConnection — kết luận: P2P KHÔNG khả dụng trên môi trường này.', 'bad');
  }
}

/** Đếm loại candidate trong SDP và phát hiện tên mDNS (.local) thay vì IP thật. */
function describeCandidates(sdp) {
  const lines = (sdp || '').split('\n').filter((line) => line.startsWith('a=candidate:'));
  let host = 0;
  let srflx = 0;
  let relay = 0;
  let mdns = 0;
  for (const line of lines) {
    if (line.includes(' typ host')) host++;
    else if (line.includes(' typ srflx')) srflx++;
    else if (line.includes(' typ relay')) relay++;
    if (line.includes('.local')) mdns++;
  }
  return { total: lines.length, host, srflx, relay, mdns };
}

// ---------------------------------------------------------------- FNV-1a

function fnv1a(bytes, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Payload 1 MiB có mẫu cố định để hai bên tính cùng một checksum tham chiếu. */
function buildPayload(size = TEST_SIZE) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

// ---------------------------------------------------------------- WebRTC

const ctx = {
  pc: null,
  dc: null,
  role: null,
  connectedAt: null,
  startedAt: null,
  sentFrames: 0,
  sentBytes: 0,
  backpressureWaits: 0,
  receivedBytes: 0,
  receivedHash: 0x811c9dc5,
  receiveStartedAt: null,
  finished: false,
};

function createPeer(label) {
  const pc = new RTCPeerConnection({ iceServers: [] }); // LAN thuần: không STUN/TURN
  ctx.pc = pc;
  ctx.role = label;
  ctx.startedAt = performance.now();
  log(`[${label}] tạo peer connection (iceServers rỗng)`);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ctx.lastCandidate = event.candidate.candidate;
    }
  };
  pc.onicegatheringstatechange = () => {
    log(`[${label}] iceGatheringState = ${pc.iceGatheringState}`);
    setState('iceGatheringState', pc.iceGatheringState);
  };
  pc.oniceconnectionstatechange = () => {
    log(`[${label}] iceConnectionState = ${pc.iceConnectionState}`);
    setState('iceConnectionState', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
      setState('Kết luận', 'ICE FAILED — trên HTTP LAN không thiết lập được', 'bad');
      log('ICE failed: đây là tín hiệu dừng (gate) cho HTTP LAN.', 'bad');
    }
  };
  pc.onconnectionstatechange = () => {
    log(`[${label}] connectionState = ${pc.connectionState}`);
    setState('connectionState', pc.connectionState);
    if (pc.connectionState === 'connected' && !ctx.connectedAt) {
      ctx.connectedAt = performance.now();
      const ms = Math.round(ctx.connectedAt - ctx.startedAt);
      setState('Thời gian tới connected', `${ms} ms`, 'ok');
      setState('Kết luận', 'P2P kết nối được trên môi trường này', 'ok');
    }
    if (pc.connectionState === 'failed') {
      setState('Kết luận', 'connectionState = failed', 'bad');
    }
  };
  pc.ondatachannel = (event) => {
    log(`[${label}] nhận data channel "${event.channel.label}"`);
    attachChannel(event.channel);
  };
  return pc;
}

function attachChannel(channel) {
  ctx.dc = channel;
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    log(`data channel mở (label=${channel.label})`, 'ok');
    setState('DataChannel', 'open', 'ok');
    el('btn-send').disabled = false;
  };
  channel.onclose = () => {
    log('data channel đóng');
    setState('DataChannel', 'closed');
    el('btn-send').disabled = true;
  };
  channel.onerror = (event) =>
    log(`data channel error: ${event?.error?.message || 'unknown'}`, 'bad');
  channel.onmessage = (event) => {
    const frame = new Uint8Array(event.data);
    if (ctx.receivedBytes === 0) ctx.receiveStartedAt = performance.now();
    ctx.receivedHash = fnv1a(frame, ctx.receivedHash);
    ctx.receivedBytes += frame.length;
    if (ctx.receivedBytes >= TEST_SIZE && !ctx.finished) {
      ctx.finished = true;
      const expected = fnv1a(buildPayload(TEST_SIZE));
      const ok = ctx.receivedHash === expected;
      const seconds = (performance.now() - ctx.receiveStartedAt) / 1000;
      setState(
        'Nhận 1 MiB',
        `${ctx.receivedBytes} byte, ${(ctx.receivedBytes / 1024 / 1024 / seconds).toFixed(1)} MiB/s, checksum ${ok ? 'khớp' : 'LỆCH'}`,
        ok ? 'ok' : 'bad'
      );
      log(`nhận đủ ${ctx.receivedBytes} byte; checksum ${ok ? 'khớp' : 'LỆCH'}`, ok ? 'ok' : 'bad');
    }
  };
}

/** Chờ ICE gathering xong để SDP chứa sẵn candidate (không cần trickle qua tay). */
function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('ICE gathering không xong trong thời gian chờ; dùng SDP hiện có', 'bad');
      resolve();
    }, ICE_WAIT_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function reportIce(pc) {
  const info = describeCandidates(pc.localDescription?.sdp || '');
  setState(
    'ICE candidate',
    `${info.total} (host ${info.host}, srflx ${info.srflx}, relay ${info.relay}; mDNS ${info.mdns})`
  );
  setState(
    'Candidate dạng IP',
    info.mdns > 0 ? 'mDNS (.local) — LAN cần resolve được mDNS' : 'IP thật trong SDP'
  );
  log(`candidate: ${info.total} tổng, host ${info.host}, srflx ${info.srflx}, mDNS ${info.mdns}`);
}

// ---------------------------------------------------------------- UI

el('btn-offer').onclick = async () => {
  el('btn-offer').disabled = true;
  const pc = createPeer('A');
  const dc = pc.createDataChannel('file');
  attachChannel(dc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  el('offer-out').value = pc.localDescription.sdp;
  reportIce(pc);
  log('A: offer đã sẵn sàng — copy sang B');
};

el('btn-copy-offer').onclick = () => copyFrom('offer-out');
el('btn-copy-answer').onclick = () => copyFrom('answer-out');

function copyFrom(id) {
  const node = el(id);
  node.select();
  navigator.clipboard?.writeText(node.value).then(
    () => log('đã copy'),
    () => log('không copy tự động được — chọn tay trong ô', 'bad')
  );
}

el('btn-answer').onclick = async () => {
  const sdp = el('offer-in').value.trim();
  if (!sdp) return log('chưa dán offer của A', 'bad');
  el('btn-answer').disabled = true;
  const pc = createPeer('B');
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc);
  el('answer-out').value = pc.localDescription.sdp;
  reportIce(pc);
  log('B: answer đã sẵn sàng — copy về A');
};

el('btn-accept').onclick = async () => {
  const sdp = el('answer-in').value.trim();
  if (!sdp) return log('chưa dán answer của B', 'bad');
  if (!ctx.pc) return log('chưa tạo offer ở bước 1', 'bad');
  el('btn-accept').disabled = true;
  await ctx.pc.setRemoteDescription({ type: 'answer', sdp });
  const info = describeCandidates(sdp);
  log(`A: đã nhận answer (${info.total} candidate)`);
};

el('btn-send').onclick = async () => {
  const dc = ctx.dc;
  if (!dc || dc.readyState !== 'open') return log('data channel chưa mở', 'bad');

  el('btn-send').disabled = true;
  const payload = buildPayload(TEST_SIZE);
  const expected = fnv1a(payload);
  dc.bufferedAmountLowThreshold = BUFFER_LOW;
  setState('DataChannel', 'đang gửi…');

  let offset = 0;
  const started = performance.now();
  while (offset < payload.length) {
    if (dc.bufferedAmount > BUFFER_HIGH) {
      // Backpressure: chờ hàng đợi rút xuống trước khi đẩy tiếp.
      ctx.backpressureWaits++;
      await new Promise((resolve) => {
        const onLow = () => {
          dc.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        dc.addEventListener('bufferedamountlow', onLow);
      });
    }
    const frame = payload.subarray(offset, Math.min(offset + FRAME_SIZE, payload.length));
    dc.send(frame);
    ctx.sentFrames++;
    offset += frame.length;
  }
  ctx.sentBytes = offset;
  const seconds = (performance.now() - started) / 1000;
  setState(
    'Xếp hàng gửi 1 MiB',
    `${offset} byte, ${ctx.sentFrames} frame, ${(seconds * 1000).toFixed(0)} ms, chờ backpressure ${ctx.backpressureWaits} lần`
  );
  setState('Checksum nguồn', expected.toString(16));
  setState('DataChannel', 'đã gửi xong');
  log(
    `đã xếp hàng ${offset} byte trong ${(seconds * 1000).toFixed(0)} ms; tốc độ thật xem ở bên nhận`,
    'ok'
  );
  el('btn-send').disabled = false;
};

el('btn-reset').onclick = () => location.reload();

reportEnvironment();
