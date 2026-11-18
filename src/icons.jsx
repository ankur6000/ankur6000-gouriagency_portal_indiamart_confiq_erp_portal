import React from 'react'

function Icon({ children, size = 24, strokeWidth = 1.8, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>
}
export const ArrowDown = p => <Icon {...p}><path d="M12 5v14M19 12l-7 7-7-7"/></Icon>
export const ArrowRight = p => <Icon {...p}><path d="M5 12h14m-7-7 7 7-7 7"/></Icon>
export const ArrowUpRight = p => <Icon {...p}><path d="M7 17 17 7M7 7h10v10"/></Icon>
export const Asterisk = p => <Icon {...p}><path d="M12 3v18M3 12h18M5.64 5.64l12.72 12.72M18.36 5.64 5.64 18.36"/></Icon>
export const Check = p => <Icon {...p}><path d="m5 12 4 4L19 6"/></Icon>
export const ChevronDown = p => <Icon {...p}><path d="m6 9 6 6 6-6"/></Icon>
export const CircleHelp = p => <Icon {...p}><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3m.1 4h.01"/></Icon>
export const Menu = p => <Icon {...p}><path d="M4 7h16M4 12h16M4 17h16"/></Icon>
export const LockKeyhole = p => <Icon {...p}><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1"/><path d="M12 17v2"/></Icon>
export const Mail = p => <Icon {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></Icon>
export const Package = p => <Icon {...p}><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/></Icon>
export const Pencil = p => <Icon {...p}><path d="m16 4 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/><path d="m14 6 4 4"/></Icon>
export const Plus = p => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>
export const ShieldCheck = p => <Icon {...p}><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></Icon>
export const Sparkles = p => <Icon {...p}><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3ZM19 14l1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2L19 14Z"/></Icon>
export const X = p => <Icon {...p}><path d="m18 6-12 12M6 6l12 12"/></Icon>
