import { message } from '@tauri-apps/plugin-dialog'
export const notify = (text: string) => message(text)
