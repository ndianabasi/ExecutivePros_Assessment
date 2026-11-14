import type { HTMLAttributes } from 'react'
import { cn } from './cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn('rounded-xl border border-slate-200 bg-white p-5 shadow-sm', className)} {...props} />
}

export function CardHeading({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('mb-3 text-lg font-bold text-slate-900', className)} {...props} />
}
