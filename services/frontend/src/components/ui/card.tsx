import type { HTMLAttributes } from 'react'
import { cn } from './cn'

/**
 * Renders a shared section container with consistent border, spacing, and accessible semantics.
 *
 * @param options - Named operation options or destructured values that configure the behavior.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn('rounded-xl border border-slate-200 bg-white p-5 shadow-sm', className)}
      {...props}
    />
  )
}

/**
 * Renders a shared heading with the semantic level and typography used by service cards.
 *
 * @param options - Named operation options or destructured values that configure the behavior.
 */
export function CardHeading({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('mb-3 text-lg font-bold text-slate-900', className)} {...props} />
}
