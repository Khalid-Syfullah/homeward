import { missingOptionalClips } from "@/content/frames.server";
import { Fallback } from "@/stage/Fallback";
import { Film } from "@/stage/Film";

export default function Home() {
  return (
    <>
      <Film initialMissing={missingOptionalClips()} />
      <Fallback />
    </>
  );
}
