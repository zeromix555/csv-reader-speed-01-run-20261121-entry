// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for the
// same {text, header}: {columns, rows, errors}, with the same broken-row
// policy (BOM drop, stray CR, unterminated quotes re-read as unquoted,
// quote junk, short/long rows, blank lines are no records). It is written
// to be fast instead of plain:
//
//   - A record that is one clean line (no quote, no stray CR in it) is
//     taken whole: one slice + String.split(','). That covers the large
//     majority of records in the drawn sets.
//   - Every other field is read by slicing spans between delimiters found
//     with indexOf / a short charCodeAt scan, never one character at a
//     time with string concatenation.
//   - A quoted field is scanned with indexOf('"') for its closing quote;
//     a segment with no CR/LF is one slice, and only segments that hold a
//     line break or a doubled quote take the slow path.
//   - No regex, no per-field allocations beyond the field strings
//     themselves, no state kept from one call to the next.
//
// Pure: no clock, no randomness, no locale, nothing cached between calls.

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Append the quoted segment [a, b) to value: each CR or CRLF inside it
  // becomes one LF, and every line break inside it counts a line.
  function appendSeg(value, a, b) {
    let r = text.indexOf('\r', a);
    if (r !== -1 && r < b) return appendSegSlow(value, a, b);
    const n = text.indexOf('\n', a);
    if (n === -1 || n >= b) return value + text.slice(a, b);
    let count = 0;
    for (let i = n; i < b; i++) if (text.charCodeAt(i) === 10) count++;
    line += count;
    return value + text.slice(a, b);
  }

  function appendSegSlow(value, a, b) {
    let s = a;
    while (s < b) {
      let r = text.indexOf('\r', s);
      if (r === -1 || r >= b) r = -1;
      let n = text.indexOf('\n', s);
      if (n === -1 || n >= b) n = -1;
      if (r === -1 && n === -1) {
        value += text.slice(s, b);
        break;
      }
      if (n !== -1 && (r === -1 || n < r)) {
        value += text.slice(s, n + 1);
        line += 1;
        s = n + 1;
      } else {
        value += text.slice(s, r) + '\n';
        line += 1;
        s = r + 1 < b && text.charCodeAt(r + 1) === 10 ? r + 2 : r + 1;
      }
    }
    return value;
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended (0 comma, 1 line break, 2 end of text); `added` counts
  // the characters kept.
  function readUnquoted(value) {
    let added = 0;
    let p = pos;
    for (;;) {
      let q = p;
      while (q < len) {
        const c = text.charCodeAt(q);
        if (c === 44 || c === 10 || c === 13) break;
        q++;
      }
      if (q > p) {
        value += text.slice(p, q);
        added += q - p;
        p = q;
      }
      if (q >= len) {
        pos = len;
        return { value, ended: 2, added };
      }
      const c = text.charCodeAt(q);
      if (c === 44) {
        pos = q + 1;
        return { value, ended: 0, added };
      }
      if (c === 10) {
        pos = q + 1;
        line += 1;
        return { value, ended: 1, added };
      }
      if (text.charCodeAt(q + 1) === 10) {
        pos = q + 2;
        line += 1;
        return { value, ended: 1, added };
      }
      error('stray_cr');
      p = q + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field
  // and how it ended (0 comma, 1 line break, 2 end of text).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    let seg = p;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        value = appendSeg(value, seg, q) + '"';
        p = q + 2;
        seg = q + 2;
        continue;
      }
      value = appendSeg(value, seg, q);
      pos = q + 1;
      if (pos >= len) return { value, ended: 2 };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: 0 };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: 1 };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: 1 };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) error('quote_junk');
      return junk;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record is one clean line (no quote, no stray CR in
    // it), so it is the whole line split on commas. A line ending in CR
    // before its LF is a CRLF ending, not a stray CR.
    let fields = null;
    let lastQuoted = false;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const qpos = text.indexOf('"', pos);
    if (qpos === -1 || qpos >= lineEnd) {
      const rpos = text.indexOf('\r', pos);
      if (rpos === -1 || rpos >= lineEnd) {
        fields = text.slice(pos, lineEnd).split(',');
        pos = nl === -1 ? len : nl + 1;
        if (nl !== -1) line += 1;
      } else if (nl !== -1 && rpos === lineEnd - 1) {
        fields = text.slice(pos, lineEnd - 1).split(',');
        pos = nl + 1;
        line += 1;
      }
    }

    if (fields === null) {
      fields = [];
      let field;
      do {
        const quoted = text.charCodeAt(pos) === 34;
        field = quoted ? readQuoted() : readUnquoted('');
        lastQuoted = quoted;
        fields.push(field.value);
      } while (field.ended === 0);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
