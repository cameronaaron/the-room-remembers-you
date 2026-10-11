import { RoomBoundary } from '@/components/room-boundary';
import { RoomInstallation } from '@/components/room-installation';

export default function Home() {
  return (
    <RoomBoundary>
      <RoomInstallation />
    </RoomBoundary>
  );
}
