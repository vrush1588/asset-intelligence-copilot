"use client";
// Map with clustering: nearby pins merge into a bubble showing how many wells it holds. Clicking a
// bubble zooms in until the wells separate; if they share one location (e.g. several spills at
// one well), the bubble lists them instead.
import { useMemo, useState } from "react";
import L from "leaflet";
import Supercluster from "supercluster";
import { MapContainer, TileLayer, CircleMarker, Marker, Popup, Tooltip, useMap, useMapEvents } from "react-leaflet";

type P = { lat: number; lon: number; label: string; detail: string; color?: string };
type Props = { i: number };

const BAD = "#d9534f";

function bubble(count: number, color: string) {
  const size = count < 10 ? 30 : count < 50 ? 36 : 44;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font:600 13px system-ui,sans-serif;box-shadow:0 0 0 4px ${color}55,0 1px 3px rgba(0,0,0,.35);border:2px solid #fff">${count}</div>`,
  });
}

function Clusters({ pts }: { pts: P[] }) {
  const map = useMap();
  const [view, setView] = useState(() => ({ zoom: map.getZoom(), bounds: map.getBounds() }));
  useMapEvents({ moveend: () => setView({ zoom: map.getZoom(), bounds: map.getBounds() }) });

  const index = useMemo(() => {
    const sc = new Supercluster<Props>({ radius: 48, maxZoom: 16 });
    sc.load(pts.map((p, i) => ({ type: "Feature", properties: { i }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })));
    return sc;
  }, [pts]);

  const b = view.bounds;
  const items = index.getClusters([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], Math.round(view.zoom));
  const singles = items.filter((f) => !(f.properties as any).cluster).length;

  return (
    <>
      {items.map((f) => {
        const [lon, lat] = f.geometry.coordinates;
        const props = f.properties as any;
        if (props.cluster) {
          const id = props.cluster_id as number;
          const leaves = index.getLeaves(id, Infinity).map((l) => pts[(l.properties as Props).i]);
          const color = leaves.some((p) => p.color === BAD) ? BAD : leaves[0]?.color ?? "#1f6feb";
          const wells = [...new Set(leaves.map((p) => p.label))];
          const expandTo = Math.min(index.getClusterExpansionZoom(id), 18);
          const sameSpot = wells.length === 1 || expandTo > 16;
          return (
            <Marker key={`c${id}`} position={[lat, lon]} icon={bubble(props.point_count, color)}
              eventHandlers={sameSpot ? undefined : { click: () => map.flyTo([lat, lon], expandTo, { duration: 0.4 }) }}>
              <Tooltip direction="top" offset={[0, -14]}>
                {props.point_count} {wells.length === props.point_count ? "wells" : "items"}: {wells.slice(0, 6).join(", ")}{wells.length > 6 ? ` +${wells.length - 6} more` : ""}
                {!sameSpot && <><br /><em>Click to zoom in</em></>}
              </Tooltip>
              {sameSpot && (
                <Popup>
                  <div style={{ maxHeight: 180, overflowY: "auto" }}>
                    {leaves.map((p, k) => <div key={k}><strong>{p.label}</strong> — {p.detail}</div>)}
                  </div>
                </Popup>
              )}
            </Marker>
          );
        }
        const p = pts[props.i];
        return (
          <CircleMarker key={`p${props.i}`} center={[lat, lon]} radius={9} pathOptions={{ color: "white", weight: 2, fillColor: p.color ?? "#1f6feb", fillOpacity: 0.95 }}>
            <Tooltip direction="top" offset={[0, -8]} permanent={singles <= 8}>{p.label}</Tooltip>
            <Popup><strong>{p.label}</strong><br />{p.detail}<br /><span style={{ opacity: 0.7 }}>{p.lat.toFixed(5)}, {p.lon.toFixed(5)}</span></Popup>
          </CircleMarker>
        );
      })}
    </>
  );
}

export default function MapView({ points }: { points: P[] }) {
  const pts = useMemo(() => points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)), [points]);
  if (!pts.length) return <p className="text-sm text-muted">No locations to show.</p>;
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const pad = 0.01;
  const bounds: [[number, number], [number, number]] = [[Math.min(...lats) - pad, Math.min(...lons) - pad], [Math.max(...lats) + pad, Math.max(...lons) + pad]];
  return (
    <div>
      <div className="h-80 overflow-hidden rounded-lg">
        <MapContainer bounds={bounds} scrollWheelZoom={false} style={{ height: "100%", width: "100%" }}>
          <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <Clusters pts={pts} />
        </MapContainer>
      </div>
      {pts.length > 8 && <p className="mt-1 text-xs text-muted">Numbers show how many wells are grouped together; click a number to zoom in.</p>}
    </div>
  );
}
