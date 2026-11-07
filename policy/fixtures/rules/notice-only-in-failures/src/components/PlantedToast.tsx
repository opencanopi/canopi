// The planted notice-only-in-failures violation (F8): a toast rendered outside failures/ and the shared slots.
import { Toast } from './shared/Toast'
export const PlantedToast = () => <Toast message="Saved" onDismiss={() => {}} />
