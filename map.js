import mapboxgl from "https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

mapboxgl.accessToken =
  "pk.eyJ1IjoibnFvdHJ1bm5hZGEiLCJhIjoiY21oenVzYms4MGV4MjJrcHpsNDRoY3plZCJ9.lW2JsQ0KHYCC-E9xiHsN4Q";

let map;
let circles;

let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString("en-US", { timeStyle: "short" });
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }

  let filteredTrips = [];
  for (let i = -60; i <= 60; i++) {
    const targetMinute = (minute + i + 1440) % 1440;
    filteredTrips.push(...tripsByMinute[targetMinute]);
  }
  return filteredTrips;
}

function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id
  );

  return stations.map((station) => {
    let id = station.short_name;
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/dark-v11",
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 10,
  maxZoom: 18,
});

map.addControl(new mapboxgl.NavigationControl());

const svg = d3.select("#map").select("svg");
const tooltip = d3.select("#tooltip");

map.on("load", async () => {
  try {
    map.addSource("boston_route", {
      type: "geojson",
      data: "https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson?outSR=%7B%22latestWkid%22%3A3857%2C%22wkid%22%3A102100%7D",
    });
    map.addLayer({
      id: "bike-lanes-boston",
      type: "line",
      source: "boston_route",
      paint: {
        "line-color": "#FFA239",
        "line-width": 2,
        "line-opacity": 0.6,
      },
    });

    map.addSource("cambridge_route", {
      type: "geojson",
      data: "https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson",
    });
    map.addLayer({
      id: "bike-lanes-cambridge",
      type: "line",
      source: "cambridge_route",
      paint: {
        "line-color": "#39FF14",
        "line-width": 2,
        "line-opacity": 0.6,
      },
    });

    console.log("Loading station data...");
    const jsonData = await d3.json(
      "https://dsc106.com/labs/lab07/data/bluebikes-stations.json"
    );
    let stationsData = jsonData.data.stations;
    console.log("Station data loaded:", stationsData);

    console.log("Loading trip data...");
    const trips = await d3.csv(
      "https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv",
      (trip) => {
        trip.started_at = new Date(trip.started_at);
        trip.ended_at = new Date(trip.ended_at);

        let startedMinutes = minutesSinceMidnight(trip.started_at);
        departuresByMinute[startedMinutes].push(trip);

        // Fill arrival buckets (Step 5.4)
        let endedMinutes = minutesSinceMidnight(trip.ended_at);
        arrivalsByMinute[endedMinutes].push(trip);

        return trip;
      }
    );
    console.log("Trip data loaded and processed:", trips);

    const stations = computeStationTraffic(stationsData);

    const radiusScale = d3
      .scaleSqrt()
      .domain([0, d3.max(stations, (d) => d.totalTraffic)])
      .range([0, 25]);

    circles = svg
      .selectAll("circle")
      .data(stations, (d) => d.short_name)
      .enter()
      .append("circle")
      .attr("r", (d) => radiusScale(d.totalTraffic))
      .style("--departure-ratio", (d) =>
        stationFlow(d.departures / (d.totalTraffic || 1))
      )
      .on("mouseover", (event, d) => {
        tooltip.transition().duration(100).style("opacity", 0.95);
        tooltip
          .html(
            `<strong>${d.name}</strong>
                             ${d.totalTraffic.toLocaleString()} total trips<br/>
                             ${d.departures.toLocaleString()} departures<br/>
                             ${d.arrivals.toLocaleString()} arrivals`
          )
          .style("left", event.pageX + "px")
          .style("top", event.pageY + "px");
      })
      .on("mouseout", (d) => {
        tooltip.transition().duration(200).style("opacity", 0);
      });

    function updatePositions() {
      circles
        .attr("cx", (d) => getCoords(d).cx)
        .attr("cy", (d) => getCoords(d).cy);
    }

    updatePositions();

    map.on("move", updatePositions);
    map.on("zoom", updatePositions);
    map.on("resize", updatePositions);
    map.on("moveend", updatePositions);

    const timeSlider = document.querySelector("#time-slider");
    const selectedTime = document.querySelector("#selected-time");
    const anyTimeLabel = document.querySelector("#any-time");

    function updateScatterPlot(timeFilter) {
      timeFilter === -1
        ? radiusScale.range([0, 25])
        : radiusScale.range([3, 50]);

      const filteredStations = computeStationTraffic(stations, timeFilter);

      circles
        .data(filteredStations, (d) => d.short_name)
        .join(
          (enter) => enter.append("circle"),
          (update) =>
            update
              .attr("r", (d) => radiusScale(d.totalTraffic))
              .style("--departure-ratio", (d) =>
                stationFlow(d.departures / (d.totalTraffic || 1))
              )
              .on("mouseover", (event, d) => {
                tooltip.transition().duration(100).style("opacity", 0.95);
                tooltip
                  .html(
                    `<strong>${d.name}</strong>
                                        ${d.totalTraffic.toLocaleString()} total trips<br/>
                                        ${d.departures.toLocaleString()} departures<br/>
                                        ${d.arrivals.toLocaleString()} arrivals`
                  )
                  .style("left", event.pageX + "px")
                  .style("top", event.pageY + "px");
              })
              .on("mouseout", (d) => {
                tooltip.transition().duration(200).style("opacity", 0);
              }),
          (exit) => exit.remove()
        );

      updatePositions();
    }

    function updateTimeDisplay() {
      let timeFilter = Number(timeSlider.value);

      if (timeFilter === -1) {
        selectedTime.textContent = "";
        anyTimeLabel.style.display = "block";
      } else {
        selectedTime.textContent = formatTime(timeFilter);
        anyTimeLabel.style.display = "none";
      }

      updateScatterPlot(timeFilter);
    }

    timeSlider.addEventListener("input", updateTimeDisplay);

    updateTimeDisplay();
  } catch (error) {
    console.error("Error loading data:", error);
    alert(
      "Failed to load critical data. Please check the console and refresh the page."
    );
  }
});
