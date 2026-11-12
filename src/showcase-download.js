// Downloads for the showcase page, counted in real bytes: every file reports what it has received and how large it is, and the
// meter adds them up so one progress figure runs from the first request to the last.

/** Adds up the files of one load. `summary().total` is 0 until every registered file has a known size. */
export function createDownloadMeter(onChange) {
  const files = new Map();
  const notify = () => onChange?.();
  return {
    register(name, total = 0) {
      files.set(name, { received: 0, total });
      notify();
    },
    update(name, received, total) {
      const file = files.get(name);
      file.received = received;
      if (total) file.total = total;
      notify();
    },
    setTotal(name, total) {
      const file = files.get(name);
      if (total) file.total = total;
      notify();
    },
    summary() {
      let received = 0;
      let total = 0;
      let sizesKnown = true;
      for (const file of files.values()) {
        received += file.received;
        total += file.total;
        if (!file.total) sizesKnown = false;
      }
      return { received, total: sizesKnown ? total : 0 };
    },
  };
}

/** The size a server reports for a file, or 0 when it reports none. Reads the headers only. */
export async function readByteLength(url, signal) {
  const response = await fetch(url, { method: 'HEAD', signal });
  return response.ok ? Number(response.headers.get('content-length')) || 0 : 0;
}

/** Streams a file into a Blob and reports each chunk to the meter under `name`. */
export async function downloadBlob(url, { meter, name, type, signal }) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url} is not available (${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  meter.setTotal(name, total);
  if (!response.body?.getReader) {
    const blob = await response.blob();
    meter.update(name, blob.size, blob.size);
    return blob;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    meter.update(name, received, total);
  }
  return new Blob(chunks, { type });
}

/**
 * The rank list the split script writes into a GLB's scene extras, or null when the file has none. Reads the JSON chunk only.
 * The script stores it as runs of consecutive ranks, `partRankRuns: [[first, count], ...]`, which keeps the JSON small.
 */
export async function readPartRanks(blob) {
  const header = new DataView(await blob.slice(0, 20).arrayBuffer());
  const jsonLength = header.getUint32(12, true);
  const document = JSON.parse(await blob.slice(20, 20 + jsonLength).text());
  const extras = document.scenes?.[document.scene ?? 0]?.extras;
  if (!extras?.partRankRuns) return extras?.partRanks ?? null;
  return extras.partRankRuns.flatMap(([first, count]) => Array.from({ length: count }, (unused, offset) => first + offset));
}

// Puts the parts of every file back in the order a one-piece load gives them, because the order sets how the renderer batches and
// draws them. Each file lists the rank of its parts in that order (the split script writes it); without ranks the files join as they are.
export function inWholeWorldOrder(files) {
  if (files.some(file => !file.ranks || file.ranks.length !== file.parts.length)) return files.flatMap(file => file.parts);
  const ranked = files.flatMap(file => file.parts.map((part, index) => ({ part, rank: file.ranks[index] })));
  return ranked.sort((first, second) => first.rank - second.rank).map(entry => entry.part);
}
