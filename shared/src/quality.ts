import type { ContainerPreference, QualityPreference } from './types';

interface Rankable {
  height?: number;
  width?: number;
  bandwidth?: number;
  container?: string;
}

function shortSide(v: Rankable): number {
  if (!v.height) return 0;
  return v.width && v.width < v.height ? v.width : v.height;
}

function compareQuality(a: Rankable, b: Rankable): number {
  return shortSide(a) - shortSide(b) || (a.bandwidth ?? 0) - (b.bandwidth ?? 0);
}

/** Sort variants from best to worst quality. */
export function sortVariantsByQuality<T extends Rankable>(variants: readonly T[]): T[] {
  return [...variants].sort((a, b) => compareQuality(b, a));
}

/**
 * Pick the variant matching a quality preference:
 * - "highest" / "lowest": the extremes
 * - "1080" etc.: the best variant at or below that height; if every variant is
 *   larger, the smallest one.
 * A container preference filters first when it leaves at least one candidate.
 */
export function pickVariant<T extends Rankable>(
  variants: readonly T[],
  quality: QualityPreference = 'highest',
  container: ContainerPreference = 'any',
): T | undefined {
  if (!variants.length) return undefined;
  let pool = [...variants];
  if (container !== 'any') {
    const filtered = pool.filter((v) => v.container === container);
    if (filtered.length) pool = filtered;
  }
  const sorted = sortVariantsByQuality(pool);
  if (quality === 'highest') return sorted[0];
  if (quality === 'lowest') return sorted[sorted.length - 1];
  const limit = Number(quality);
  return sorted.find((v) => shortSide(v) > 0 && shortSide(v) <= limit) ?? sorted[sorted.length - 1];
}
