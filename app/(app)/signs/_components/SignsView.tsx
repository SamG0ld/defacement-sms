"use client";

import { useDevice } from "@/app/_components/DeviceProvider";

// Device-driven choice between the desktop table and the mobile cards. Both are
// server-rendered and passed in as slots (the RSC "client picks among server
// children" pattern, same as AppShell slotting `children`); this client wrapper
// mounts exactly ONE of them based on useDevice(). The client islands inside
// (RowCheckbox) still read useSelection() from the SelectionProvider ancestor.
//
// This replaces the old CSS `md:` split (hidden md:block / md:hidden), which
// rendered BOTH trees and keyed off the viewport alone — so a wide-screen
// installed PWA wrongly got the desktop table under the mobile shell. Keying off
// useDevice() aligns the breakpoint with the shell and halves the hydrated rows.
export function SignsView({
  table,
  cards,
}: {
  table: React.ReactNode;
  cards: React.ReactNode;
}) {
  const { isMobile } = useDevice();
  return <>{isMobile ? cards : table}</>;
}
