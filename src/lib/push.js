// Push notifications on this device: turning them on/off and reporting what's possible.
// Sending happens in the send-push Edge Function (supabase/functions/send-push).
import { supabase } from '../supabaseClient';

// Public half of the VAPID key pair; the private half is a secret on the Edge Function.
const VAPID_PUBLIC_KEY = 'BJsV0uNYPduyWoEXLWUpKYy42TlQ8BPHXcKoONDDYBizkaSmFbbaCIcrWX-rG8YcfBSy4GzSWfA2Xz4qSGQeEUg';

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  }
}

// 'on' | 'off' | 'blocked' (permission denied) | 'install' (iPhone: add to Home Screen first)
// | 'unsupported'
export async function pushStatus() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return isIOS() && !isInstalled() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function keyBytes(b64url) {
  const b64 = (b64url + '='.repeat((4 - b64url.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Must be called from a tap (browsers only show the permission prompt for a user gesture).
export async function enablePush() {
  if (await Notification.requestPermission() !== 'granted') return pushStatus();
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  const { keys } = sub.toJSON();
  const { error } = await supabase.rpc('save_push_subscription',
    { p_endpoint: sub.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth });
  if (error) throw error;
  return 'on';
}

export async function disablePush() {
  const reg = await navigator.serviceWorker?.getRegistration(import.meta.env.BASE_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint });
  await sub.unsubscribe();
}
