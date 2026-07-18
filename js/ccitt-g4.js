// CCITT Group 4 (ITU-T T.6) Encoder für 1-Bit-Bitmaps.
// Codetabellen aus libtiff t4.h (ITU-T T.4 Huffman-Runlength-Codes).
// Eingabe: Uint8Array (1 Byte pro Pixel, 1 = schwarz, 0 = weiß).
// Ausgabe: G4-komprimierter Datenstrom mit EOFB, byte-aligned,
// passend zu PDF CCITTFaxDecode mit /K -1 /Columns w /Rows h.

const WHITE_TERM = {"0":[8,53],"1":[6,7],"2":[4,7],"3":[4,8],"4":[4,11],"5":[4,12],"6":[4,14],"7":[4,15],"8":[5,19],"9":[5,20],"10":[5,7],"11":[5,8],"12":[6,8],"13":[6,3],"14":[6,52],"15":[6,53],"16":[6,42],"17":[6,43],"18":[7,39],"19":[7,12],"20":[7,8],"21":[7,23],"22":[7,3],"23":[7,4],"24":[7,40],"25":[7,43],"26":[7,19],"27":[7,36],"28":[7,24],"29":[8,2],"30":[8,3],"31":[8,26],"32":[8,27],"33":[8,18],"34":[8,19],"35":[8,20],"36":[8,21],"37":[8,22],"38":[8,23],"39":[8,40],"40":[8,41],"41":[8,42],"42":[8,43],"43":[8,44],"44":[8,45],"45":[8,4],"46":[8,5],"47":[8,10],"48":[8,11],"49":[8,82],"50":[8,83],"51":[8,84],"52":[8,85],"53":[8,36],"54":[8,37],"55":[8,88],"56":[8,89],"57":[8,90],"58":[8,91],"59":[8,74],"60":[8,75],"61":[8,50],"62":[8,51],"63":[8,52]};
const WHITE_MAKEUP = {"64":[5,27],"128":[5,18],"192":[6,23],"256":[7,55],"320":[8,54],"384":[8,55],"448":[8,100],"512":[8,101],"576":[8,104],"640":[8,103],"704":[9,204],"768":[9,205],"832":[9,210],"896":[9,211],"960":[9,212],"1024":[9,213],"1088":[9,214],"1152":[9,215],"1216":[9,216],"1280":[9,217],"1344":[9,218],"1408":[9,219],"1472":[9,152],"1536":[9,153],"1600":[9,154],"1664":[6,24],"1728":[9,155],"1792":[11,8],"1856":[11,12],"1920":[11,13],"1984":[12,18],"2048":[12,19],"2112":[12,20],"2176":[12,21],"2240":[12,22],"2304":[12,23],"2368":[12,28],"2432":[12,29],"2496":[12,30],"2560":[12,31]};
const BLACK_TERM = {"0":[10,55],"1":[3,2],"2":[2,3],"3":[2,2],"4":[3,3],"5":[4,3],"6":[4,2],"7":[5,3],"8":[6,5],"9":[6,4],"10":[7,4],"11":[7,5],"12":[7,7],"13":[8,4],"14":[8,7],"15":[9,24],"16":[10,23],"17":[10,24],"18":[10,8],"19":[11,103],"20":[11,104],"21":[11,108],"22":[11,55],"23":[11,40],"24":[11,23],"25":[11,24],"26":[12,202],"27":[12,203],"28":[12,204],"29":[12,205],"30":[12,104],"31":[12,105],"32":[12,106],"33":[12,107],"34":[12,210],"35":[12,211],"36":[12,212],"37":[12,213],"38":[12,214],"39":[12,215],"40":[12,108],"41":[12,109],"42":[12,218],"43":[12,219],"44":[12,84],"45":[12,85],"46":[12,86],"47":[12,87],"48":[12,100],"49":[12,101],"50":[12,82],"51":[12,83],"52":[12,36],"53":[12,55],"54":[12,56],"55":[12,39],"56":[12,40],"57":[12,88],"58":[12,89],"59":[12,43],"60":[12,44],"61":[12,90],"62":[12,102],"63":[12,103]};
const BLACK_MAKEUP = {"64":[10,15],"128":[12,200],"192":[12,201],"256":[12,91],"320":[12,51],"384":[12,52],"448":[12,53],"512":[13,108],"576":[13,109],"640":[13,74],"704":[13,75],"768":[13,76],"832":[13,77],"896":[13,114],"960":[13,115],"1024":[13,116],"1088":[13,117],"1152":[13,118],"1216":[13,119],"1280":[13,82],"1344":[13,83],"1408":[13,84],"1472":[13,85],"1536":[13,90],"1600":[13,91],"1664":[13,100],"1728":[13,101],"1792":[11,8],"1856":[11,12],"1920":[11,13],"1984":[12,18],"2048":[12,19],"2112":[12,20],"2176":[12,21],"2240":[12,22],"2304":[12,23],"2368":[12,28],"2432":[12,29],"2496":[12,30],"2560":[12,31]};

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
  }
  write(len, code) {
    this.acc = (this.acc << len) | (code & ((1 << len) - 1));
    this.nbits += len;
    while (this.nbits >= 8) {
      this.nbits -= 8;
      this.bytes.push((this.acc >>> this.nbits) & 0xff);
    }
    // acc klein halten, damit keine 32-Bit-Überläufe entstehen
    this.acc &= (1 << this.nbits) - 1;
  }
  finish() {
    if (this.nbits > 0) {
      this.bytes.push((this.acc << (8 - this.nbits)) & 0xff);
      this.nbits = 0;
      this.acc = 0;
    }
    return new Uint8Array(this.bytes);
  }
}

function writeRun(bw, runLen, isWhite) {
  const term = isWhite ? WHITE_TERM : BLACK_TERM;
  const makeup = isWhite ? WHITE_MAKEUP : BLACK_MAKEUP;
  let r = runLen;
  while (r >= 2624) {
    const [len, code] = makeup[2560];
    bw.write(len, code);
    r -= 2560;
  }
  if (r >= 64) {
    const m = r - (r % 64);
    const [len, code] = makeup[m];
    bw.write(len, code);
    r -= m;
  }
  const [len, code] = term[r];
  bw.write(len, code);
}

// Ermittelt die Wechselpositionen einer Zeile (Übergänge weiß<->schwarz),
// beginnend mit einem gedachten weißen Pixel vor Position 0.
function changingElements(row, width, out) {
  let n = 0;
  let prev = 0;
  for (let x = 0; x < width; x++) {
    const c = row[x];
    if (c !== prev) {
      out[n++] = x;
      prev = c;
    }
  }
  out[n] = width;
  out[n + 1] = width;
  out[n + 2] = width;
  return n;
}

export function encodeG4(bitmap, width, height) {
  const bw = new BitWriter();
  let refChanges = new Int32Array(width + 3);
  let curChanges = new Int32Array(width + 3);
  let refCount = 0; // Referenzzeile: gedachte weiße Zeile -> keine Wechsel
  refChanges[0] = width;
  refChanges[1] = width;
  refChanges[2] = width;

  for (let y = 0; y < height; y++) {
    const row = bitmap.subarray(y * width, (y + 1) * width);
    const curCount = changingElements(row, width, curChanges);

    let a0 = -1;
    let a0IsWhite = true;
    let curIdx = 0; // Index des nächsten Wechsels > a0 in curChanges

    while (a0 < width) {
      // a1: nächster Wechsel auf der Codierzeile rechts von a0
      while (curIdx < curCount && curChanges[curIdx] <= a0) curIdx++;
      const a1 = curIdx < curCount ? curChanges[curIdx] : width;
      const a2 = curIdx + 1 < curCount ? curChanges[curIdx + 1] : width;

      // b1: erster Wechsel der Referenzzeile rechts von a0 mit Farbe
      // entgegengesetzt zu a0 (Wechsel mit geradem Index -> zu schwarz).
      const wantParity = a0IsWhite ? 0 : 1;
      let bIdx = wantParity;
      while (bIdx < refCount && refChanges[bIdx] <= a0) bIdx += 2;
      const b1 = bIdx < refCount ? refChanges[bIdx] : width;
      const b2 = bIdx + 1 < refCount ? refChanges[bIdx + 1] : width;

      if (b2 < a1) {
        // Pass-Modus
        bw.write(4, 0b0001);
        a0 = b2;
      } else if (Math.abs(a1 - b1) <= 3) {
        // Vertikal-Modus
        const d = a1 - b1;
        if (d === 0) bw.write(1, 0b1);
        else if (d === 1) bw.write(3, 0b011);
        else if (d === 2) bw.write(6, 0b000011);
        else if (d === 3) bw.write(7, 0b0000011);
        else if (d === -1) bw.write(3, 0b010);
        else if (d === -2) bw.write(6, 0b000010);
        else bw.write(7, 0b0000010); // d === -3
        a0 = a1;
        a0IsWhite = !a0IsWhite;
      } else {
        // Horizontal-Modus: zwei Läufe (a0a1, a1a2)
        bw.write(3, 0b001);
        const run1 = a1 - (a0 < 0 ? 0 : a0);
        const run2 = a2 - a1;
        writeRun(bw, run1, a0IsWhite);
        writeRun(bw, run2, !a0IsWhite);
        a0 = a2;
      }
    }

    // Codierzeile wird Referenzzeile
    const tmp = refChanges;
    refChanges = curChanges;
    curChanges = tmp;
    refCount = curCount;
  }

  // EOFB: zwei EOL-Codes (je 000000000001)
  bw.write(12, 0b000000000001);
  bw.write(12, 0b000000000001);
  return bw.finish();
}
