// csv-reader-speed v2 — a faster drop-in for csv-reader 1.0.0.
//
// Written from scratch in-session. Pure dependency-free JavaScript (the
// competition runs JavaScript/TypeScript only: no WebAssembly, native addon
// or prebuilt binary is allowed, so speed comes from the scanner design,
// not from a compiled language).
//
// Design: the reference reader walks one character at a time and builds
// every field with `value += c`. This reader instead delimits unquoted
// fields with native `indexOf` scans (`,` and `\n`, whichever is nearer)
// and slices each field out whole; quoted fields are scanned with
// `indexOf('"')`. Per-character work happens only on the rare paths:
// stray CRs inside an unquoted field, and CR/LF normalisation inside a
// quoted field. The observable behaviour is csv-reader 1.0.0's exactly:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is
//     no record;
//   - outside a quoted field a CR not followed by LF is dropped
//     (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote, and each CRLF or lone CR inside
//     it is read as LF; what follows its closing quote, up to the next
//     comma or line break, is appended as it stands (quote_junk, when
//     the field ends); a quote that never closes is a literal character,
//     and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields
//     stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows
//     holds the records after it (every record when header is false),
//     each padded with "" (short_row, with fields: its count) or cut
//     (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on (every LF, CRLF and lone CR inside a quoted field
//     counted), row its record's index in rows (null for the header), in
//     the order met, a field's quote_junk when the field ends and a
//     record's short_row or long_row when the record ends.

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** `seg` holds CR and/or LF: the same text with every CRLF and lone CR as one LF. */
function normSeg(seg) {
  let out = '';
  let i = 0;
  const n = seg.length;
  while (i < n) {
    const ch = seg.charCodeAt(i);
    if (ch === 13) {
      out += '\n';
      i += seg.charCodeAt(i + 1) === 10 ? 2 : 1;
    } else {
      out += seg[i];
      i += 1;
    }
  }
  return out;
}

/** The line breaks `seg` holds: every LF, and every CR (a CRLF counts once). */
function countBreaks(seg) {
  let k = 0;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg.charCodeAt(i);
    if (ch === 13) {
      k += 1;
      if (seg.charCodeAt(i + 1) === 10) i += 1;
    } else if (ch === 10) {
      k += 1;
    }
  }
  return k;
}

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = len > 0 && text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and its index in rows.
  let recordLine = 1;
  let recordRow = null;

  // Quoted-field scratch: the value built so far and its line-break count.
  let qv = '';
  let ql = 0;

  // Appends one slice of a quoted field, normalising its line breaks.
  function pushSeg(seg) {
    if (seg.indexOf('\r') === -1) {
      if (seg.indexOf('\n') === -1) {
        qv += seg;
        return;
      }
      ql += seg.split('\n').length - 1;
      qv += seg;
      return;
    }
    qv += normSeg(seg);
    ql += countBreaks(seg);
  }

  // Unquoted-field scratch: the value read, how it ended, chars kept.
  let uv = '';
  let ue = COMMA;
  let ua = 0;

  // Reads an unquoted field from pos, starting from `init`. The next
  // delimiter (`,` or LF) is found with native indexOf scans; a CR inside
  // the field is a stray_cr unless it is the CRLF that ends the record.
  function scanUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      const c = text.indexOf(',', pos);
      const n = text.indexOf('\n', pos);
      if (c !== -1 && (n === -1 || c < n)) {
        const f = text.slice(pos, c);
        pos = c + 1;
        if (f.indexOf('\r') === -1) {
          value += f;
          added += f.length;
        } else {
          // No CRLF can hide here: a CR followed by LF would have made
          // that LF nearer than this comma. Every CR is stray.
          const k = f.split('\r').length - 1;
          for (let i = 0; i < k; i++) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          }
          const clean = f.replaceAll('\r', '');
          value += clean;
          added += clean.length;
        }
        uv = value;
        ue = COMMA;
        ua = added;
        return;
      }
      if (n !== -1) {
        const f = text.slice(pos, n);
        pos = n + 1;
        line += 1;
        if (f.indexOf('\r') === -1) {
          value += f;
          added += f.length;
        } else if (f.charCodeAt(f.length - 1) === 13 && f.indexOf('\r') === f.length - 1) {
          // The only CR is the one before this LF: a CRLF ending the record.
          value += f.slice(0, -1);
          added += f.length - 1;
        } else {
          // Stray CRs, possibly plus a trailing CRLF CR.
          const trailing = f.charCodeAt(f.length - 1) === 13;
          const body = trailing ? f.slice(0, -1) : f;
          const k = body.split('\r').length - 1;
          for (let i = 0; i < k; i++) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          }
          const clean = body.replaceAll('\r', '');
          value += clean;
          added += clean.length;
        }
        uv = value;
        ue = BREAK;
        ua = added;
        return;
      }
      const f = text.slice(pos);
      pos = len;
      if (f.indexOf('\r') === -1) {
        value += f;
        added += f.length;
      } else {
        // No LF follows anywhere in here, so every CR is stray.
        const k = f.split('\r').length - 1;
        for (let i = 0; i < k; i++) {
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        }
        const clean = f.replaceAll('\r', '');
        value += clean;
        added += clean.length;
      }
      uv = value;
      ue = END;
      ua = added;
      return;
    }
  }

  for (;;) {
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

    // Fast path: a line holding no quote at all. Its fields are one native
    // split(','); a stray CR anywhere in it falls back to the slow path
    // below, which records each stray_cr. (A quoted field spanning lines
    // always puts a quote on its first line, so this path never sees one.)
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= lineEnd) {
      let contentEnd = lineEnd;
      if (nl !== -1 && contentEnd > pos && text.charCodeAt(contentEnd - 1) === 13) {
        contentEnd -= 1; // CRLF ending the record
      }
      const seg = text.slice(pos, contentEnd);
      if (seg.indexOf('\r') === -1) {
        const fields = seg.split(',');
        pos = nl === -1 ? len : nl + 1;
        if (nl !== -1) line += 1;
        if (fields.length === 1 && fields[0] === '') continue;
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
        continue;
      }
    }

    const fields = [];
    let quoted = false;
    let ended = COMMA;

    do {
      quoted = text.charCodeAt(pos) === 34;
      let fval;
      if (quoted) {
        const open = pos;
        const openLine = line;
        qv = '';
        ql = 0;
        let p = pos + 1;
        let closedAt = -1;
        for (;;) {
          const q = text.indexOf('"', p);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            pushSeg(text.slice(p, q));
            qv += '"';
            p = q + 2;
            continue;
          }
          closedAt = q;
          pushSeg(text.slice(p, q));
          break;
        }
        if (closedAt === -1) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          line = openLine;
          pos = open + 1;
          scanUnquoted('"');
          fval = uv;
          ended = ue;
        } else {
          line += ql;
          pos = closedAt + 1;
          if (pos >= len) {
            fval = qv;
            ended = END;
          } else {
            const ch = text.charCodeAt(pos);
            if (ch === 44) {
              pos += 1;
              fval = qv;
              ended = COMMA;
            } else if (ch === 10) {
              pos += 1;
              line += 1;
              fval = qv;
              ended = BREAK;
            } else if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fval = qv;
              ended = BREAK;
            } else {
              // What follows the closing quote is appended as it stands.
              scanUnquoted(qv);
              if (ua > 0) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
              fval = uv;
              ended = ue;
            }
          }
        }
      } else {
        scanUnquoted('');
        fval = uv;
        ended = ue;
      }
      fields.push(fval);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

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
