import { missingOptionalClips, readManifests } from "@/content/frames.server";
import { Fallback } from "@/stage/Fallback";
import { Film } from "@/stage/Film";

export default function Home() {
  const manifests = readManifests();
  return (
    <>
      <Film initialMissing={missingOptionalClips(manifests)} manifests={manifests} />
      <Fallback />
    </>
  );
}
