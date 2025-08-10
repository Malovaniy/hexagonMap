import { Subscription } from 'rxjs';

export interface CachedHexagon {
  feature: GeoFeature<PolygonGeometry, { color: string }>;
}

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: [number, number][][];
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: [number, number][][][];
}

export interface GeoFeature<
  G = PolygonGeometry | MultiPolygonGeometry,
  P = Record<string, unknown>
> {
  type: 'Feature';
  geometry: G;
  properties: P;
}

export interface GeoJson {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

export interface AnimatedPolygon {
  polygon: google.maps.Polygon;
  animationSubscription?: Subscription;
}
