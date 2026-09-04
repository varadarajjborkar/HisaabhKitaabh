import { redirect } from 'next/navigation'
import { readSession } from '@/lib/auth'
import { env } from '@/lib/env'
import { AppShell } from '@/components/AppShell'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession()
  if (!session) redirect('/login')

  return (
    <AppShell session={session} aiEnabled={env.ollama.enabled}>
      {children}
    </AppShell>
  )
}
