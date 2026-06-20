interface ScoreBoxProps {
  label: string;
  value: string | number;
}

export function ScoreBox({ label, value }: ScoreBoxProps) {
  return (
    <div className="min-w-[78px] rounded-[10px] bg-gradient-to-b from-orange-500 to-orange-700 px-4 py-2 text-center shadow-[0_7px_0_#ad4600]">
      <span className="mb-0.5 block text-[0.62rem] font-bold tracking-wide text-[#eee4da]">{label}</span>
      <span className="block text-[1.35rem] font-black text-white">{value}</span>
    </div>
  );
}