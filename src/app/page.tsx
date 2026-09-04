import { redirect } from 'next/navigation'
import { readSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function Root() {
  const session = await readSession()
  redirect(session ? '/home' : '/login')
}
