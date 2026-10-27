// tauri-only-in-native-host: @tauri-apps outside the native host.
import { invoke } from '@tauri-apps/api/core';
export const planted = invoke;
