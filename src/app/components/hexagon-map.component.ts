import { Component, OnInit, OnDestroy, inject, viewChild } from '@angular/core';
import { GoogleMap, GoogleMapsModule } from '@angular/google-maps';
import { CommonModule } from '@angular/common';
import proj4 from 'proj4';
import * as h3 from 'h3-js';
import {
  Subject,
  debounceTime,
  Subscription,
  timer,
  takeUntil,
  interval,
  map,
  take,
} from 'rxjs';
import {
  AnimatedPolygon,
  CachedHexagon,
  GeoFeature,
  GeoJson,
  MultiPolygonGeometry,
  PolygonGeometry,
} from '../interfaces/hexagon-interfaces';
import { HexagonService } from '../services/hexagon.service';

@Component({
  selector: 'hexagon-map',
  standalone: true,
  imports: [CommonModule, GoogleMapsModule],
  providers: [HexagonService],
  template: `
    <google-map
      #googleMap
      height="100vh"
      width="100%"
      [center]="center"
      [zoom]="zoom"
      [options]="options"
    ></google-map>
  `,
})
export class hexagonMapComponent implements OnInit, OnDestroy {
  googleMap = viewChild(GoogleMap);

  private hexagonService = inject(HexagonService);
  private destroy$ = new Subject<void>();

  center!: google.maps.LatLngLiteral;
  zoom = 5;
  options: google.maps.MapOptions = {
    mapTypeId: 'roadmap',
    zoomControl: true,
    scrollwheel: true,
    disableDoubleClickZoom: false,
    maxZoom: 18,
    minZoom: 2,
  };

  private dataFeatures: GeoFeature[] = [];
  private currentPolygons: AnimatedPolygon[] = [];
  private hexagonCache = new Map<string, CachedHexagon[]>();
  private updateSubject = new Subject<void>();
  private mapListeners: google.maps.MapsEventListener[] = [];
  private subscriptions: Subscription[] = [];
  private isInitialLoad = true;

  ngOnInit() {
    this.defineProjections();
    this.subscriptions.push(
      this.updateSubject
        .pipe(debounceTime(150), takeUntil(this.destroy$))
        .subscribe(() => this.updateHexagons())
    );

    this.loadData();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    this.updateSubject.complete();
    this.clearHexagons();
    this.mapListeners.forEach((l) => l.remove());
    this.subscriptions.forEach((s) => s.unsubscribe());
  }

  private defineProjections(): void {
    proj4.defs(
      'EPSG:3857',
      '+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 ' +
        '+x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs'
    );
    proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
  }

  private loadData(): void {
    this.hexagonService.getHexagons().subscribe({
      next: (geojson: GeoJson) => {
        this.setupMapEvents(this.googleMap()!.googleMap as google.maps.Map);
        const transformed = this.transformCoordinates(
          geojson,
          'EPSG:3857',
          'EPSG:4326'
        ) as GeoJson;
        this.dataFeatures = transformed.features;
        if (this.isInitialLoad && this.dataFeatures.length > 0) {
          const coords = this.getPolygonCenter(this.dataFeatures[0]);
          if (coords) {
            this.center = { lat: coords.lat, lng: coords.lng };
          }
          this.isInitialLoad = false;
        }
        this.triggerUpdate();
      },
      error: (err) => console.error('Error loading data.json:', err),
    });
  }

  private getPolygonCenter(
    feature: GeoFeature
  ): { lat: number; lng: number } | null {
    const polygons =
      feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates]
        : feature.geometry.type === 'MultiPolygon'
        ? feature.geometry.coordinates
        : [];
    if (!polygons.length) return null;
    const firstPolygon = polygons[0];
    const ring = firstPolygon[0];
    if (!ring || !ring.length) return null;
    let sumLat = 0;
    let sumLng = 0;
    ring.forEach(([lng, lat]) => {
      sumLat += lat;
      sumLng += lng;
    });
    return {
      lat: sumLat / ring.length,
      lng: sumLng / ring.length,
    };
  }

  private transformCoordinates(
    geojson: GeoJson | GeoFeature | PolygonGeometry | MultiPolygonGeometry,
    fromProj: string,
    toProj: string
  ): typeof geojson {
    const transformed = JSON.parse(JSON.stringify(geojson));
    if (transformed.type === 'FeatureCollection') {
      transformed.features = transformed.features.map(
        (f: GeoFeature) =>
          this.transformCoordinates(f, fromProj, toProj) as GeoFeature
      );
    } else if (transformed.type === 'Feature') {
      transformed.geometry = this.transformCoordinates(
        transformed.geometry,
        fromProj,
        toProj
      ) as PolygonGeometry | MultiPolygonGeometry;
    } else if (transformed.type === 'Polygon') {
      transformed.coordinates = transformed.coordinates.map(
        (ring: [number, number][]) =>
          ring.map((coord) => proj4(fromProj, toProj, coord))
      );
    } else if (transformed.type === 'MultiPolygon') {
      transformed.coordinates = transformed.coordinates.map(
        (poly: [number, number][][]) =>
          poly.map((ring: [number, number][]) =>
            ring.map((coord) => proj4(fromProj, toProj, coord))
          )
      );
    }
    return transformed;
  }

  private setupMapEvents(map: google.maps.Map): void {
    this.mapListeners.push(
      map.addListener('idle', () => this.triggerUpdate()),
      map.addListener('zoom_changed', () => this.triggerUpdate())
    );
  }

  private triggerUpdate(): void {
    this.updateSubject.next();
  }

  private getOptimalResolution(zoom: number): number {
    const resMap: Record<number, number> = {
      2: 1,
      3: 2,
      4: 2,
      5: 3,
      6: 3,
      7: 4,
      8: 4,
      9: 5,
      10: 5,
      11: 6,
      12: 6,
      13: 7,
      14: 8,
      15: 9,
      16: 10,
      17: 11,
      18: 12,
    };
    const z = Math.max(2, Math.min(18, Math.round(zoom)));
    return resMap[z] || 6;
  }

  private clearHexagons(): void {
    this.currentPolygons.forEach((animatedPolygon) => {
      if (animatedPolygon.animationSubscription) {
        animatedPolygon.animationSubscription.unsubscribe();
      }
      animatedPolygon.polygon.setMap(null);
    });
    this.currentPolygons = [];
  }

  private updateHexagons(): void {
    if (!this.googleMap()?.googleMap || !this.dataFeatures.length) return;
    const map = this.googleMap()?.googleMap!;
    const bounds = map.getBounds();
    if (!bounds) return;
    const zoom = map.getZoom() || 8;
    const resolution = this.getOptimalResolution(zoom);
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const buffer = 0.5;
    const viewBounds = {
      minLat: sw.lat() - buffer,
      maxLat: ne.lat() + buffer,
      minLng: sw.lng() - buffer,
      maxLng: ne.lng() + buffer,
    };
    const cacheKey = `${resolution}_${Math.round(
      viewBounds.minLat * 10
    )}_${Math.round(viewBounds.minLng * 10)}`;
    if (this.hexagonCache.has(cacheKey)) {
      this.clearHexagons();
      this.renderHexagons(
        this.hexagonCache.get(cacheKey)!.map((h) => h.feature)
      );
      return;
    }
    const hexagonFeatures: GeoFeature<PolygonGeometry, { color: string }>[] =
      [];
    const processedHexagons = new Set<string>();
    this.dataFeatures.forEach((feature) => {
      if (!feature.geometry?.coordinates) return;
      const polygons =
        feature.geometry.type === 'Polygon'
          ? [feature.geometry.coordinates]
          : feature.geometry.type === 'MultiPolygon'
          ? feature.geometry.coordinates
          : [];
      polygons.forEach((poly) => {
        const flatCoords = poly.flat();
        flatCoords.forEach(([lng, lat]) => {
          if (
            lat >= viewBounds.minLat &&
            lat <= viewBounds.maxLat &&
            lng >= viewBounds.minLng &&
            lng <= viewBounds.maxLng
          ) {
            const h3Index = h3.latLngToCell(lat, lng, resolution);
            if (!processedHexagons.has(h3Index)) {
              processedHexagons.add(h3Index);
              const boundary = h3
                .cellToBoundary(h3Index)
                .map(([bLat, bLng]) => [bLng, bLat]) as [number, number][];
              boundary.push(boundary[0]);
              hexagonFeatures.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [boundary] },
                properties: {
                  color: `#${feature.properties['COLOR_HEX'] || 'cccccc'}`,
                },
              });
            }
          }
        });
      });
    });
    this.hexagonCache.set(
      cacheKey,
      hexagonFeatures.map((f) => ({ feature: f }))
    );
    this.clearHexagons();
    this.renderHexagons(hexagonFeatures);
  }

  private renderHexagons(
    hexagonFeatures: GeoFeature<PolygonGeometry, { color: string }>[]
  ): void {
    const googleMap = this.googleMap()?.googleMap!;
    hexagonFeatures.forEach((feature, index) => {
      const paths = feature.geometry.coordinates[0].map(([lng, lat]) => ({
        lat,
        lng,
      }));
      const polygon = new google.maps.Polygon({
        paths,
        strokeColor: '#000',
        strokeOpacity: 0.5,
        strokeWeight: 1,
        fillColor: feature.properties.color,
        fillOpacity: 0,
        map: googleMap,
      });
      timer(index * 5)
        .pipe(takeUntil(this.destroy$))
        .subscribe(() => {
          const targetOpacity = 0.6;
          const animationDuration = 300;
          const frameRate = 60;
          const totalFrames = (animationDuration / 1000) * frameRate;
          const opacityStep = targetOpacity / totalFrames;
          const animationSubscription = interval(1000 / frameRate)
            .pipe(
              take(totalFrames),
              map((frame: number) => frame * opacityStep),
              takeUntil(this.destroy$)
            )
            .subscribe({
              next: (opacity: number) => {
                polygon.setOptions({
                  fillOpacity: Math.min(opacity, targetOpacity),
                });
              },
              complete: () => {
                polygon.setOptions({ fillOpacity: targetOpacity });
              },
            });
          this.currentPolygons.push({
            polygon,
            animationSubscription,
          });
        });
    });
  }
}
