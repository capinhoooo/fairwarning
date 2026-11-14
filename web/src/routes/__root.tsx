import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import HeroUIProvider from '../providers/HeroUIProvider'
import LenisSmoothScrollProvider from '../providers/LenisSmoothScrollProvider'
import { ThemeProvider } from '../providers/ThemeProvider'
import ErrorPage from '../components/ErrorPage'
import Nav from '../components/fw/Nav'
import Footer from '../components/fw/Footer'
import NotFound from '../components/fw/NotFound'
import { config } from '../config'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  errorComponent: ({ error, reset }) => (
    <ErrorPage error={error} reset={reset} />
  ),
  notFoundComponent: NotFound,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { title: 'Fair Warning · Notice-or-pay bonds for admin keys' },
      { name: 'description', content: config.appDescription },
      { name: 'theme-color', content: '#000000' },
      { property: 'og:title', content: 'Fair Warning' },
      { property: 'og:description', content: config.appDescription },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.ico' },
    ],
  }),
  component: RootLayout,
  shellComponent: RootDocument,
})

function RootLayout() {
  return (
    <>
      <Nav />
      <main>
        <Outlet />
      </main>
      <Footer />
    </>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=JSON.parse(localStorage.getItem('theme')||'"dark"');var c=document.documentElement.classList;c.remove('dark','light');c.add(t==='light'?'light':'dark')}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <HeroUIProvider>
            <LenisSmoothScrollProvider />
            {children}
            {import.meta.env.DEV && (
              <TanStackDevtools
                config={{ position: 'bottom-left' }}
                plugins={[
                  {
                    name: 'Tanstack Router',
                    render: <TanStackRouterDevtoolsPanel />,
                  },
                  TanStackQueryDevtools,
                ]}
              />
            )}
          </HeroUIProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}
