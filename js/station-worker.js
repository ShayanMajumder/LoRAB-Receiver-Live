// One of the station workers: receives a port to the radio worker, then
// demodulates the stations it is given (see station-core.js).

import { StationCore } from "./station-core.js";

onmessage = ({ data }) => {
  if (data.type === "port") new StationCore(data.port);
};
