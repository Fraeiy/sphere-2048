import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
  children: ReactNode;
}

export function Button({ variant = 'primary', className = '', children, ...props }: ButtonProps) {
  const base = 'rounded-full px-5 py-2.5 text-sm font-bold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-45';
  const styles = variant === 'primary'
    ? 'bg-gradient-to-b from-orange-500 to-orange-700 text-white hover:opacity-90'
    : 'bg-gradient-to-b from-[#8a5a38] to-[#6b452b] text-white hover:opacity-90';

  return (
    <button className={`${base} ${styles} ${className}`} {...props}>
      {children}
    </button>
  );
}