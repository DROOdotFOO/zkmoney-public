/** The `{name}` placeholders a copy string holds, read from its literal type. */
export type Placeholders<T extends string> = T extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never

type Vars<T extends string> = [Placeholders<T>] extends [never]
  ? []
  : [vars: Record<Placeholders<T>, string | number>]

/** A copy string with its placeholders filled; a missing or unknown one is a type error. */
export function fmt<T extends string>(template: T, ...[vars]: Vars<T>): string {
  if (!vars) return template
  const values = vars as Record<string, string | number>
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  )
}
