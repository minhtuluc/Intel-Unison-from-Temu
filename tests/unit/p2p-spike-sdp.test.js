import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSdpToken, encodeSdpToken } from '../../public/spike/sdp-envelope.js';

describe('P2P spike SDP envelope', () => {
  const sdp = [
    'v=0',
    'o=- 6991351711045335962 2 IN IP4 127.0.0.1',
    'm=application 58306 UDP/DTLS/SCTP webrtc-datachannel',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');

  it('preserves every SDP line through a single-line copy token', () => {
    const token = encodeSdpToken(sdp);

    assert.match(token, /^utrans-sdp-v1:[A-Za-z0-9+/=]+$/);
    assert.equal(token.includes('\n'), false);
    assert.equal(token.includes('http'), false);
    assert.equal(decodeSdpToken(token), sdp);
  });

  it('tolerates visual whitespace inserted around a token', () => {
    const token = encodeSdpToken(sdp);
    const wrapped = `  ${token.slice(0, 40)}\n${token.slice(40)}  `;
    assert.equal(decodeSdpToken(wrapped), sdp);
  });

  it('still accepts raw SDP for local/manual use', () => {
    assert.equal(decodeSdpToken(`\n${sdp}\n`), sdp.trim());
  });
});
