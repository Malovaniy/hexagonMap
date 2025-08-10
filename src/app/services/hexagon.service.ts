import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { GeoJson } from '../interfaces/hexagon-interfaces';

@Injectable({
  providedIn: 'root',
})
export class HexagonService {
  private readonly http = inject(HttpClient);

  getHexagons() {
    return this.http.get('/assets/data.json') as Observable<GeoJson>;
  }
}
