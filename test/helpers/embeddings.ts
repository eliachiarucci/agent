// Deterministic stand-ins for real embeddings in unit tests. Distinct seeds
// produce near-orthogonal vectors in 768 dimensions (cosine ≈ 0), the same
// seed reproduces the same vector (cosine = 1) — enough to script relevance
// exactly without LM Studio.

export function fakeEmbedding(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = h || 1;
  const vector: number[] = [];
  for (let i = 0; i < 768; i++) {
    // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    vector.push(((x >>> 0) % 2000) / 1000 - 1);
  }
  return normalize(vector);
}

function normalize(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return vector.map((v) => v / length);
}
