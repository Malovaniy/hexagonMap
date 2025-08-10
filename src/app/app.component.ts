import { Component } from '@angular/core';
import { hexagonMapComponent } from './components/hexagon-map.component';

@Component({
  selector: 'app-root',
  imports: [hexagonMapComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {}
