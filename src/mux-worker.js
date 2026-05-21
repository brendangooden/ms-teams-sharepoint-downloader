// Off-main-thread fMP4 → flat MP4 muxer. Receives one message:
//   { video: ArrayBuffer[], audio: ArrayBuffer[] }
// where each array is [initSegment, ...mediaSegments] for that track (i.e. the
// shape downloadDashSegments returns). Concatenates internally, runs the
// existing splice-moov / defragment / write-flat-MP4 pipeline, posts back:
//   { result: Uint8Array } or { error: string }
// and streams progress as:
//   { progress: { done, total, text } }
//
// The mux logic itself is lifted verbatim from the in-content muxTracks that
// used to run on the UI thread; only the I/O wrapper at top + bottom is new.

self.addEventListener('message', async (event) => {
  const { video, audio } = event.data || {};
  if (!video || !audio) {
    self.postMessage({ error: 'mux-worker: missing video or audio chunks' });
    return;
  }

  function reportProgress(done, total, text) {
    self.postMessage({ progress: { done, total, text } });
  }

  function concatChunks(chunks) {
    const total = chunks.reduce((s, b) => s + b.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of chunks) {
      out.set(b instanceof Uint8Array ? b : new Uint8Array(b), off);
      off += b.byteLength;
    }
    return out;
  }

  try {
    const videoUint8 = concatChunks(video);
    const audioUint8 = concatChunks(audio);
    const result = mux(videoUint8, audioUint8, reportProgress);
    // Transfer the result buffer back rather than structured-cloning it
    self.postMessage({ result }, [result.buffer]);
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
});

// ============================================================================
// Mux logic (ported from content.js muxTracks). Builds combined moov, then
// defragments to flat (non-fragmented) MP4 compatible with VLC seeking.
// ============================================================================

function mux(videoUint8, audioUint8, onProgress) {
  function readU32(b, off) {
    return ((b[off] << 24) | (b[off+1] << 16) | (b[off+2] << 8) | b[off+3]) >>> 0;
  }
  function writeU32(b, off, val) {
    b[off] = (val >>> 24) & 0xFF; b[off+1] = (val >>> 16) & 0xFF;
    b[off+2] = (val >>> 8) & 0xFF; b[off+3] = val & 0xFF;
  }
  function btype(b, off) {
    return String.fromCharCode(b[off], b[off+1], b[off+2], b[off+3]);
  }
  function cat(...arrays) {
    const out = new Uint8Array(arrays.reduce((s, a) => s + a.byteLength, 0));
    let o = 0; for (const a of arrays) { out.set(a, o); o += a.byteLength; }
    return out;
  }

  function findBox(b, type, startOff = 0, maxOff = b.length) {
    let pos = startOff;
    while (pos + 8 <= maxOff) {
      const size = readU32(b, pos);
      if (size < 8) break;
      if (btype(b, pos + 4) === type) return { offset: pos, size };
      pos += size;
    }
    return null;
  }

  onProgress(0, 1, 'Muxing tracks...');

  const vMoovBox = findBox(videoUint8, 'moov');
  const aMoovBox = findBox(audioUint8, 'moov');
  if (!vMoovBox) throw new Error('No moov found in video buffer');
  if (!aMoovBox) throw new Error('No moov found in audio buffer');

  const vMoov = videoUint8.slice(vMoovBox.offset, vMoovBox.offset + vMoovBox.size);
  const aMoov = audioUint8.slice(aMoovBox.offset, aMoovBox.offset + aMoovBox.size);

  // ---- Extract audio trak, patch tkhd.track_id = 2 ----
  const aTrakBox = findBox(aMoov, 'trak', 8);
  if (!aTrakBox) throw new Error('No trak in audio moov');
  const aTrak = new Uint8Array(aMoov.slice(aTrakBox.offset, aTrakBox.offset + aTrakBox.size));
  const aTkhdBox = findBox(aTrak, 'tkhd', 8);
  if (aTkhdBox) {
    const v = aTrak[aTkhdBox.offset + 8];
    writeU32(aTrak, aTkhdBox.offset + (v === 1 ? 28 : 20), 2);
  }

  // ---- Extract audio trex, patch track_id = 2 (or build minimal one) ----
  let aTrex;
  const aMvexBox = findBox(aMoov, 'mvex', 8);
  if (aMvexBox) {
    const aTrexBox = findBox(aMoov, 'trex', aMvexBox.offset + 8);
    if (aTrexBox) {
      aTrex = new Uint8Array(aMoov.slice(aTrexBox.offset, aTrexBox.offset + aTrexBox.size));
      writeU32(aTrex, 12, 2);
    }
  }
  if (!aTrex) {
    aTrex = new Uint8Array([
      0x00,0x00,0x00,0x20, 0x74,0x72,0x65,0x78,
      0x00,0x00,0x00,0x00,
      0x00,0x00,0x00,0x02,
      0x00,0x00,0x00,0x01,
      0x00,0x00,0x00,0x00,
      0x00,0x00,0x00,0x00,
      0x00,0x00,0x00,0x00,
    ]);
  }

  // ---- Build combined moov ----
  const workMoov = new Uint8Array(vMoov);

  const vMvhdBox = findBox(workMoov, 'mvhd', 8);
  if (vMvhdBox) {
    const v = workMoov[vMvhdBox.offset + 8];
    writeU32(workMoov, vMvhdBox.offset + (v === 1 ? 116 : 104), 3);
  }

  const vMvexBox = findBox(workMoov, 'mvex', 8);
  let combinedMoov;

  if (vMvexBox) {
    const oldMvex = workMoov.slice(vMvexBox.offset, vMvexBox.offset + vMvexBox.size);
    const newMvex = cat(oldMvex, aTrex);
    writeU32(newMvex, 0, newMvex.length);

    const beforeMvex  = workMoov.slice(8, vMvexBox.offset);
    const afterMvex   = workMoov.slice(vMvexBox.offset + vMvexBox.size);
    const moovContent = cat(beforeMvex, aTrak, newMvex, afterMvex);
    combinedMoov = new Uint8Array(8 + moovContent.length);
    writeU32(combinedMoov, 0, combinedMoov.length);
    combinedMoov.set([0x6D,0x6F,0x6F,0x76], 4);
    combinedMoov.set(moovContent, 8);
  } else {
    const vTrex = new Uint8Array([
      0x00,0x00,0x00,0x20, 0x74,0x72,0x65,0x78,
      0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x01,
      0x00,0x00,0x00,0x01, 0x00,0x00,0x00,0x00,
      0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
    ]);
    const mvexContent = cat(vTrex, aTrex);
    const mvex = new Uint8Array(8 + mvexContent.length);
    writeU32(mvex, 0, mvex.length);
    mvex.set([0x6D,0x76,0x65,0x78], 4);
    mvex.set(mvexContent, 8);

    const moovContent = cat(workMoov.slice(8), aTrak, mvex);
    combinedMoov = new Uint8Array(8 + moovContent.length);
    writeU32(combinedMoov, 0, combinedMoov.length);
    combinedMoov.set([0x6D,0x6F,0x6F,0x76], 4);
    combinedMoov.set(moovContent, 8);
  }

  // ---- Defragment ----
  function collectFragments(bytes) {
    const frags = [];
    let pos = 0;
    while (pos + 8 <= bytes.length) {
      const size = readU32(bytes, pos);
      if (size < 8) break;
      if (btype(bytes, pos + 4) === 'moof') {
        let trafData = null;
        let mp = pos + 8;
        while (mp + 8 <= pos + size) {
          const csz = readU32(bytes, mp);
          if (csz < 8) break;
          if (btype(bytes, mp + 4) === 'traf') {
            trafData = bytes.slice(mp, mp + csz);
            break;
          }
          mp += csz;
        }
        const nextPos = pos + size;
        let mdatPayload = null;
        if (nextPos + 8 <= bytes.length && btype(bytes, nextPos + 4) === 'mdat') {
          const mdatSize = readU32(bytes, nextPos);
          mdatPayload = bytes.slice(nextPos + 8, nextPos + mdatSize);
        }
        if (trafData && mdatPayload) frags.push({ traf: trafData, mdatPayload });
      }
      pos += size;
    }
    return frags;
  }

  function parseTrafSamples(trafBytes) {
    let defDur = 0, defSize = 0, defFlags = 0;
    const samples = [];
    let pos = 8;
    while (pos + 8 <= trafBytes.length) {
      const sz = readU32(trafBytes, pos);
      if (sz < 8) break;
      const t = btype(trafBytes, pos + 4);
      if (t === 'tfhd') {
        const fl = ((trafBytes[pos+9]<<16)|(trafBytes[pos+10]<<8)|trafBytes[pos+11])>>>0;
        let o = pos + 16;
        if (fl & 1) o += 8;
        if (fl & 2) o += 4;
        if (fl & 8) { defDur = readU32(trafBytes, o); o += 4; }
        if (fl & 0x10) { defSize = readU32(trafBytes, o); o += 4; }
        if (fl & 0x20) { defFlags = readU32(trafBytes, o); o += 4; }
      }
      if (t === 'trun') {
        const fl = ((trafBytes[pos+9]<<16)|(trafBytes[pos+10]<<8)|trafBytes[pos+11])>>>0;
        const cnt = readU32(trafBytes, pos + 12);
        let o = pos + 16;
        if (fl & 1) o += 4;
        let firstFlags = defFlags;
        if (fl & 4) { firstFlags = readU32(trafBytes, o); o += 4; }
        for (let i = 0; i < cnt; i++) {
          let dur = defDur, size = defSize, flags = (i === 0) ? firstFlags : defFlags, cts = 0;
          if (fl & 0x100) { dur = readU32(trafBytes, o); o += 4; }
          if (fl & 0x200) { size = readU32(trafBytes, o); o += 4; }
          if (fl & 0x400) { flags = readU32(trafBytes, o); o += 4; }
          if (fl & 0x800) { cts = readU32(trafBytes, o); o += 4; }
          samples.push({ duration: dur, size, flags, ctsOffset: cts });
        }
      }
      pos += sz;
    }
    return samples;
  }

  const vFrags = collectFragments(videoUint8);
  const aFrags = collectFragments(audioUint8);

  const vSamples = vFrags.flatMap(f => parseTrafSamples(f.traf));
  const aSamples = aFrags.flatMap(f => parseTrafSamples(f.traf));

  const vData = cat(...vFrags.map(f => f.mdatPayload));
  const aData = cat(...aFrags.map(f => f.mdatPayload));

  onProgress(0, 1, 'Building MP4...');

  function makeBox(type, ...contents) {
    const totalContent = contents.reduce((s, c) => s + c.byteLength, 0);
    const box = new Uint8Array(8 + totalContent);
    writeU32(box, 0, box.length);
    for (let i = 0; i < 4; i++) box[4 + i] = type.charCodeAt(i);
    let off = 8;
    for (const c of contents) { box.set(c, off); off += c.byteLength; }
    return box;
  }

  function makeFullBox(type, version, flags, content) {
    const vf = new Uint8Array(4);
    vf[0] = version;
    vf[1] = (flags >> 16) & 0xFF; vf[2] = (flags >> 8) & 0xFF; vf[3] = flags & 0xFF;
    return makeBox(type, vf, content);
  }

  function buildStts(samples) {
    const runs = [];
    for (const s of samples) {
      if (runs.length > 0 && runs[runs.length - 1].dur === s.duration) {
        runs[runs.length - 1].count++;
      } else {
        runs.push({ count: 1, dur: s.duration });
      }
    }
    const data = new Uint8Array(4 + 4 + runs.length * 8);
    writeU32(data, 4, runs.length);
    for (let i = 0; i < runs.length; i++) {
      writeU32(data, 8 + i * 8, runs[i].count);
      writeU32(data, 12 + i * 8, runs[i].dur);
    }
    return makeBox('stts', data);
  }

  function buildStsz(samples) {
    const allSame = samples.length > 0 && samples.every(s => s.size === samples[0].size);
    const data = new Uint8Array(4 + 4 + 4 + (allSame ? 0 : samples.length * 4));
    writeU32(data, 4, allSame ? samples[0].size : 0);
    writeU32(data, 8, samples.length);
    if (!allSame) {
      for (let i = 0; i < samples.length; i++) {
        writeU32(data, 12 + i * 4, samples[i].size);
      }
    }
    return makeBox('stsz', data);
  }

  function buildStsc() {
    const data = new Uint8Array(4 + 4 + 12);
    writeU32(data, 4, 1);
    writeU32(data, 8, 1);
    writeU32(data, 12, 0);
    writeU32(data, 16, 1);
    return makeBox('stsc', data);
  }

  function buildStco() {
    const data = new Uint8Array(4 + 4 + 4);
    writeU32(data, 4, 1);
    writeU32(data, 8, 0);
    return makeBox('stco', data);
  }

  function buildStss(samples) {
    const syncIndices = [];
    for (let i = 0; i < samples.length; i++) {
      if (!(samples[i].flags & 0x10000)) syncIndices.push(i + 1);
    }
    const data = new Uint8Array(4 + 4 + syncIndices.length * 4);
    writeU32(data, 4, syncIndices.length);
    for (let i = 0; i < syncIndices.length; i++) {
      writeU32(data, 8 + i * 4, syncIndices[i]);
    }
    return makeBox('stss', data);
  }

  function buildCtts(samples) {
    if (samples.every(s => s.ctsOffset === 0)) return null;
    const runs = [];
    for (const s of samples) {
      if (runs.length > 0 && runs[runs.length - 1].offset === s.ctsOffset) {
        runs[runs.length - 1].count++;
      } else {
        runs.push({ count: 1, offset: s.ctsOffset });
      }
    }
    const data = new Uint8Array(4 + 4 + runs.length * 8);
    writeU32(data, 4, runs.length);
    for (let i = 0; i < runs.length; i++) {
      writeU32(data, 8 + i * 8, runs[i].count);
      writeU32(data, 12 + i * 8, runs[i].offset);
    }
    return makeBox('ctts', data);
  }

  function extractBox(parent, type, startOff, maxOff) {
    const box = findBox(parent, type, startOff || 0, maxOff || parent.length);
    return box ? parent.slice(box.offset, box.offset + box.size) : null;
  }

  const existingMvhd = extractBox(combinedMoov, 'mvhd', 8);

  const traks = [];
  let tp = 8;
  while (tp + 8 <= combinedMoov.length) {
    const sz = readU32(combinedMoov, tp);
    if (sz < 8) break;
    if (btype(combinedMoov, tp + 4) === 'trak') {
      traks.push(combinedMoov.slice(tp, tp + sz));
    }
    tp += sz;
  }

  function extractFromTrak(trak) {
    const tkhd = extractBox(trak, 'tkhd', 8);
    const mdiaBox = findBox(trak, 'mdia', 8);
    const mdia = mdiaBox ? trak.slice(mdiaBox.offset, mdiaBox.offset + mdiaBox.size) : null;
    let mdhd = null, hdlr = null, stsd = null, isVideo = false;
    if (mdia) {
      mdhd = extractBox(mdia, 'mdhd', 8);
      hdlr = extractBox(mdia, 'hdlr', 8);
      if (hdlr) {
        isVideo = btype(hdlr, 16) === 'vide';
      }
      const minfBox = findBox(mdia, 'minf', 8);
      if (minfBox) {
        const minf = mdia.slice(minfBox.offset, minfBox.offset + minfBox.size);
        const stblBox = findBox(minf, 'stbl', 8);
        if (stblBox) {
          const stbl = minf.slice(stblBox.offset, stblBox.offset + stblBox.size);
          stsd = extractBox(stbl, 'stsd', 8);
        }
        const vmhd = extractBox(minf, 'vmhd', 8);
        const smhd = extractBox(minf, 'smhd', 8);
        return { tkhd, mdhd, hdlr, stsd, isVideo, xmhd: vmhd || smhd };
      }
    }
    return { tkhd, mdhd, hdlr, stsd, isVideo, xmhd: null };
  }

  const vTrakInfo = extractFromTrak(traks[0]);
  const aTrakInfo = extractFromTrak(traks[1]);

  function buildTrak(info, samples, sampleCount) {
    const stts = buildStts(samples);
    const stsz = buildStsz(samples);
    const stss = info.isVideo ? buildStss(samples) : null;
    const ctts = buildCtts(samples);

    const stsc = buildStsc();
    writeU32(stsc, 20, sampleCount);

    const stco = buildStco();

    const urlBox = makeFullBox('url ', 0, 1, new Uint8Array(0));
    const drefData = new Uint8Array(4 + 4);
    writeU32(drefData, 4, 1);
    const dref = makeBox('dref', drefData, urlBox);
    const dinf = makeBox('dinf', dref);

    const stblParts = [info.stsd, stts, stsc, stsz, stco];
    if (stss) stblParts.push(stss);
    if (ctts) stblParts.push(ctts);
    const stbl = makeBox('stbl', ...stblParts);

    const minf = makeBox('minf', info.xmhd, dinf, stbl);
    const mdia = makeBox('mdia', info.mdhd, info.hdlr, minf);
    const trak = makeBox('trak', info.tkhd, mdia);
    return trak;
  }

  const newVTrak = buildTrak(vTrakInfo, vSamples, vSamples.length);
  const newATrak = buildTrak(aTrakInfo, aSamples, aSamples.length);

  function getMdhdTimescale(mdhd) {
    const v = mdhd[8];
    return readU32(mdhd, v === 1 ? 28 : 20);
  }
  const vTimescale = getMdhdTimescale(vTrakInfo.mdhd);
  const aTimescale = getMdhdTimescale(aTrakInfo.mdhd);
  const vTotalDur = vSamples.reduce((s, x) => s + x.duration, 0);
  const aTotalDur = aSamples.reduce((s, x) => s + x.duration, 0);

  function patchMdhdDuration(trak, duration) {
    const mdiaBox = findBox(trak, 'mdia', 8);
    if (!mdiaBox) return;
    const mdhdBox = findBox(trak, 'mdhd', mdiaBox.offset + 8, mdiaBox.offset + mdiaBox.size);
    if (!mdhdBox) return;
    const v = trak[mdhdBox.offset + 8];
    writeU32(trak, mdhdBox.offset + (v === 1 ? 32 : 24), duration);
  }

  function patchTkhdDuration(trak, movieDuration) {
    const tkhdBox = findBox(trak, 'tkhd', 8);
    if (!tkhdBox) return;
    const v = trak[tkhdBox.offset + 8];
    writeU32(trak, tkhdBox.offset + (v === 1 ? 36 : 28), movieDuration);
  }

  patchMdhdDuration(newVTrak, vTotalDur);
  patchMdhdDuration(newATrak, aTotalDur);

  const mvhdV = existingMvhd[8];
  const movieTimescale = readU32(existingMvhd, mvhdV === 1 ? 28 : 20);
  const vMovieDur = Math.round(vTotalDur * movieTimescale / vTimescale);
  const aMovieDur = Math.round(aTotalDur * movieTimescale / aTimescale);
  const maxMovieDur = Math.max(vMovieDur, aMovieDur);
  writeU32(existingMvhd, mvhdV === 1 ? 32 : 24, maxMovieDur);
  patchTkhdDuration(newVTrak, vMovieDur);
  patchTkhdDuration(newATrak, aMovieDur);

  const newMoov = makeBox('moov', existingMvhd, newVTrak, newATrak);

  const vFtypBox = findBox(videoUint8, 'ftyp');
  const ftyp = vFtypBox ? videoUint8.slice(vFtypBox.offset, vFtypBox.offset + vFtypBox.size) : new Uint8Array(0);

  const mdatPayload = cat(vData, aData);
  const mdatBox = new Uint8Array(8 + mdatPayload.length);
  writeU32(mdatBox, 0, mdatBox.length);
  mdatBox[4]=0x6D; mdatBox[5]=0x64; mdatBox[6]=0x61; mdatBox[7]=0x74;
  mdatBox.set(mdatPayload, 8);

  const videoDataOffset = ftyp.length + newMoov.length + 8;
  const audioDataOffset = videoDataOffset + vData.length;

  function patchStcoInMoov(moov, trakIndex, offset) {
    let trakCount = 0;
    let p = 8;
    while (p + 8 <= moov.length) {
      const sz = readU32(moov, p);
      if (sz < 8) break;
      if (btype(moov, p + 4) === 'trak') {
        if (trakCount === trakIndex) {
          const stcoBox = (function findDeep(buf, type, start, end) {
            let pos = start;
            while (pos + 8 <= end) {
              const s = readU32(buf, pos);
              if (s < 8) break;
              if (btype(buf, pos + 4) === type) return pos;
              const inner = findDeep(buf, type, pos + 8, pos + s);
              if (inner !== -1) return inner;
              pos += s;
            }
            return -1;
          })(moov, 'stco', p + 8, p + sz);
          if (stcoBox !== -1) {
            writeU32(moov, stcoBox + 16, offset);
          }
          return;
        }
        trakCount++;
      }
      p += sz;
    }
  }

  patchStcoInMoov(newMoov, 0, videoDataOffset);
  patchStcoInMoov(newMoov, 1, audioDataOffset);

  return cat(ftyp, newMoov, mdatBox);
}
