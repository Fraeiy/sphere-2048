import type { Board } from '@sphere-2048/game';
import { useSwipe } from '@/hooks/useSwipe';

const TILE_STYLES: Record<number, string> = {
  2: 'bg-[#fff0dd] text-[#7a5a45]',
  4: 'bg-[#ffe6c8] text-[#714f38]',
  8: 'bg-[#ffc07b] text-[#fff8f2]',
  16: 'bg-[#ffab5d] text-[#fff8f2]',
  32: 'bg-[#ff9742] text-[#fff8f2]',
  64: 'bg-orange-500 text-[#fff8f2]',
  128: 'bg-orange-600 text-[#fff8f2] text-2xl',
  256: 'bg-[#d95b00] text-[#fff8f2] text-2xl',
  512: 'bg-[#c75000] text-[#fff8f2] text-2xl',
  1024: 'bg-[#a94400] text-[#fff8f2] text-xl',
  2048: 'bg-[#823500] text-[#fff8f2] text-xl',
};

interface GameBoardProps {
  board: Board;
  onMove: (direction: 'left' | 'right' | 'up' | 'down') => void;
  disabled?: boolean;
}

export function GameBoard({ board, onMove, disabled }: GameBoardProps) {
  const bind = useSwipe(onMove, disabled);

  return (
    <div
      {...bind}
      className="aspect-square w-full max-w-[460px] cursor-grab touch-none select-none rounded-[10px] bg-gradient-to-br from-[#f3bf8d] to-[#de8f4f] p-3 shadow-[0_20px_34px_rgba(130,64,19,0.25)] active:cursor-grabbing"
      aria-label="Swipe or drag to move tiles"
    >
      <div className="grid h-full w-full grid-cols-4 grid-rows-4 gap-2.5">
        {board.flatMap((row, r) =>
          row.map((value, c) => (
            <div
              key={`${r}-${c}`}
              data-v={value || undefined}
              className={`flex items-center justify-center rounded-md text-3xl font-black transition ${
                value ? TILE_STYLES[value] ?? 'bg-orange-700 text-white' : 'bg-tile-empty'
              }`}
            >
              {value || ''}
            </div>
          )),
        )}
      </div>
    </div>
  );
}