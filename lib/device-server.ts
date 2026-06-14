import { cookies } from "next/headers";

import { DEVICE_COOKIE, type Device } from "./device";

// Server-side seed for the adaptive shell's first render. Reads the cookie a
// prior client visit wrote (see DeviceProvider); defaults to "desktop" when
// absent, so a first-ever visitor on a phone sees a single client-side
// correction and the cookie persists thereafter. The client is the source of
// truth once mounted — this only removes the flash for returning/installed users.
export async function getDeviceHint(): Promise<Device> {
  const store = await cookies();
  return store.get(DEVICE_COOKIE)?.value === "mobile" ? "mobile" : "desktop";
}
