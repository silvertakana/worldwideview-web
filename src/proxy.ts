import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const host = request.headers.get('host') ?? '';
  if (host.startsWith('docs.')) {
    const pathname = request.nextUrl.pathname;
    if (pathname.startsWith('/docs')) return; // already prefixed, serve directly
    const url = request.nextUrl.clone();
    url.pathname = pathname === '/' ? '/docs' : `/docs${pathname}`;
    return NextResponse.rewrite(url);
  }
}

export const config = {
  matcher: ['/((?!_next/|favicon\\.ico).*)'],
};
