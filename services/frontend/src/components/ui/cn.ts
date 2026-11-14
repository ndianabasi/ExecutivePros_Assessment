import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Combines Tailwind class inputs and resolves conflicting utility classes.
 *
 * @param values - Utility-class values supplied to the shared class-name combiner.
 */
export function cn(...values: ClassValue[]) {
  return twMerge(clsx(values))
}
