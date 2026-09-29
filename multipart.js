'use strict';
/**
 * multipart.js — minimal multipart/form-data parser, no dependencies.
 * Works on Buffers only: file bytes are never converted to strings,
 * so binary uploads (photos) survive intact.
 */

/**
 * @param {http.IncomingMessage} req
 * @param {{maxBytes:number}} opts
 * @returns {Promise<{fields: Record<string,string>, files: Array<{field, filename, contentType, data: Buffer}>}>}
 */
function parseMultipart(req, { maxBytes = 12 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const ctype = req.headers['content-type'] || '';
    const m = /boundary=([^;]+)/i.exec(ctype);
    if (!m) return reject(new Error('not-multipart'));
    const boundary = Buffer.from('--' + m[1].trim().replace(/^"|"$/g, ''));

    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > maxBytes) {
        failed = true;
        reject(new Error('upload-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(splitParts(Buffer.concat(chunks), boundary));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function splitParts(body, boundary) {
  const fields = {};
  const files = [];

  let pos = body.indexOf(boundary);
  if (pos === -1) throw new Error('bad-multipart');
  pos += boundary.length;

  for (;;) {
    // After a boundary comes either "--" (final) or CRLF + part headers.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // "--"
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;

    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) throw new Error('bad-multipart');
    const headerText = body.toString('latin1', pos, headerEnd);

    const disp = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
    if (!disp) throw new Error('bad-part');
    const name = disp[1];
    const filename = disp[2]; // undefined when the part is a text field
    const typeM = /content-type:\s*([^\r\n;]+)/i.exec(headerText);
    const contentType = typeM ? typeM[1].trim() : 'text/plain';

    const dataStart = headerEnd + 4;
    const nextBoundary = body.indexOf(boundary, dataStart);
    if (nextBoundary === -1) throw new Error('bad-multipart');
    let dataEnd = nextBoundary;
    if (body[dataEnd - 1] === 0x0a && body[dataEnd - 2] === 0x0d) dataEnd -= 2; // strip trailing CRLF

    const data = body.subarray(dataStart, dataEnd);
    if (filename !== undefined && filename !== '') {
      files.push({ field: name, filename, contentType, data });
    } else {
      fields[name] = data.toString('utf8');
    }
    pos = nextBoundary + boundary.length;
  }

  return { fields, files };
}

module.exports = { parseMultipart };
