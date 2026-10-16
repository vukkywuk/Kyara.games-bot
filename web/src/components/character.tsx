import { memo, useState } from 'react';
import { RARITY } from '../lib/rarity';
import type { Character, Rarity } from '../lib/types';
import { cx } from './ui';

/** The rarity as a hanko seal: kanji in a stamped frame, tilted like a hand-pressed mark. */
export function RaritySeal({ rarity, size = 26, className, decorative }: { rarity: Rarity; size?: number; className?: string; decorative?: boolean }) {
  const r = RARITY[rarity];
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : r.name}
      aria-hidden={decorative || undefined}
      title={decorative ? undefined : r.name}
      className={cx('inline-grid shrink-0 place-items-center font-bold leading-none', className)}
      style={{
        width: size,
        height: size,
        color: r.color,
        border: `${Math.max(1.5, size / 14)}px solid ${r.color}`,
        borderRadius: 3,
        fontSize: size * 0.56,
        transform: 'rotate(-4deg)',
        background: 'var(--color-seal-bg)',
      }}
    >
      {r.kanji}
    </span>
  );
}

/** Fixed-ratio art: rarity-tinted placeholder until loaded, graceful fallback on error. */
export const CharacterArt = memo(function CharacterArt({
  character,
  className,
  sizes,
  eager,
}: {
  character: Pick<Character, 'id' | 'name' | 'image' | 'rarity'>;
  className?: string;
  sizes?: string;
  eager?: boolean;
}) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>(character.image ? 'loading' : 'error');
  const r = RARITY[character.rarity];
  return (
    <div className={cx('relative aspect-[2/3] overflow-hidden rounded-[var(--radius-art)] bg-ink-2 [container-type:inline-size]', className)}>
      <div
        aria-hidden
        className={cx('absolute inset-0 grid place-items-center transition-opacity duration-300', state === 'ok' ? 'opacity-0' : 'opacity-100')}
        style={{ background: `linear-gradient(160deg, color-mix(in oklab, ${r.color} 14%, var(--color-ink-2)), var(--color-ink-1))` }}
      >
        <span className="font-bold opacity-25" style={{ color: r.color, fontSize: '42cqw' }}>
          {r.kanji}
        </span>
      </div>
      {character.image && state !== 'error' && (
        <img
          src={character.image}
          alt={character.name}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          sizes={sizes}
          referrerPolicy="no-referrer"
          onLoad={() => setState('ok')}
          onError={() => setState('error')}
          className={cx('absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ease-out', state === 'ok' ? 'opacity-100' : 'opacity-0')}
          draggable={false}
        />
      )}
    </div>
  );
});

/**
 * A character as a collectible object. Art first; identity in a strip below; rarity as a
 * seal; the native name set vertically along the art's edge.
 */
export const CharacterCard = memo(function CharacterCard({
  character,
  owned,
  onOpen,
  selected,
}: {
  character: Character;
  owned?: number;
  onOpen?: (c: Character) => void;
  selected?: boolean;
}) {
  const r = RARITY[character.rarity];
  return (
    <button
      type="button"
      onClick={() => onOpen?.(character)}
      aria-label={`${character.name}, ${r.name}, ${character.series}${owned ? `, owned ${owned}` : ''}`}
      className={cx(
        'group relative flex w-full flex-col text-left outline-offset-4 [container-type:inline-size]',
        'transition-transform duration-200 ease-out hover:-translate-y-0.5 motion-reduce:hover:translate-y-0',
      )}
    >
      <div className="relative w-full">
        <CharacterArt character={character} sizes="200px" />
        {/* rarity edge: a 2px rule in the rarity colour, the only colour on the card */}
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px]" style={{ background: r.color }} />
        <RaritySeal rarity={character.rarity} size={24} className="absolute left-2 top-2" />
        {character.native && (
          <span
            aria-hidden
            className="vertical-name absolute right-1.5 top-2 max-h-[78%] overflow-hidden text-[11px] font-medium text-washi/90 [text-shadow:0_1px_3px_rgb(0_0_0/0.85)]"
          >
            {character.native}
          </span>
        )}
        {owned ? (
          <span className="num absolute bottom-2 right-2 rounded-[var(--radius-chip)] bg-ink-0/85 px-1.5 py-0.5 text-[11px] font-bold text-washi">×{owned}</span>
        ) : null}
        {selected && <span aria-hidden className="absolute inset-0 rounded-[var(--radius-art)] ring-2 ring-washi" />}
      </div>
      <div className="mt-2 min-w-0 px-0.5">
        <p className="truncate text-sm font-bold text-washi group-hover:text-washi-hi">{character.name}</p>
        <p className="truncate text-xs text-muted">{character.series}</p>
      </div>
    </button>
  );
});
