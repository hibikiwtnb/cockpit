/*
 * Copyright (C) 2019 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */
import React from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardFooter, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Progress, ProgressMeasureLocation, ProgressVariant } from "@patternfly/react-core/dist/esm/components/Progress/index.js";

import * as machine_info from "machine-info.js";
import cockpit from "cockpit";
import * as python from "python";
import { superuser } from "superuser";
import gpu_metrics from "./gpu-metrics.py";

import "./usageCard.scss";

const _ = cockpit.gettext;

const METRICS_SPEC = {
    payload: "metrics1",
    source: "internal",
    interval: 3000,
    metrics: [
        { name: "cpu.basic.user", derive: "rate" },
        { name: "cpu.basic.system", derive: "rate" },
        { name: "cpu.basic.nice", derive: "rate" },
        { name: "memory.used" },
    ]
};

export class UsageCard extends React.Component {
    constructor(props) {
        super(props);

        this.metrics_channel = null;
        this.samples = [];
        this.gpu_timer = null;
        this.gpu_process = null;
        this.gpu_active = false;

        this.state = {
            memTotal: 0, // bytes
            memUsed: 0, // bytes
            memUsedText: " ",
            numCpu: 1, // number
            cpuUsed: 0, // percentage
            gpus: [],
            gpuError: false,
        };

        this.onVisibilityChange = this.onVisibilityChange.bind(this);
        this.onMetricsUpdate = this.onMetricsUpdate.bind(this);
        this.onGpuPermissionChange = this.onGpuPermissionChange.bind(this);
    }

    componentDidMount() {
        machine_info.cpu_ram_info()
                .then(info => this.setState({
                    memTotal: info.memory,
                    numCpu: info.cpus,
                }));
        cockpit.addEventListener("visibilitychange", this.onVisibilityChange);
        superuser.addEventListener("changed", this.onGpuPermissionChange);
        this.onVisibilityChange();
    }

    componentWillUnmount() {
        cockpit.removeEventListener("visibilitychange", this.onVisibilityChange);
        superuser.removeEventListener("changed", this.onGpuPermissionChange);
        this.stopGpuMetrics();
        if (this.metrics_channel)
            this.metrics_channel.close();
    }

    stopGpuMetrics() {
        this.gpu_active = false;
        window.clearTimeout(this.gpu_timer);
        if (this.gpu_process) {
            this.gpu_process.close();
            this.gpu_process = null;
        }
    }

    onGpuPermissionChange() {
        this.stopGpuMetrics();
        if (!cockpit.hidden) {
            this.gpu_active = true;
            this.updateGpuMetrics();
        }
    }

    async updateGpuMetrics() {
        const process = python.spawn(gpu_metrics, ["--watch"], { err: "message", superuser: "try" });
        this.gpu_process = process;
        let pending = "";
        process.stream(chunk => {
            if (!this.gpu_active || this.gpu_process !== process)
                return;
            pending += chunk;
            let end;
            while ((end = pending.indexOf("\n")) !== -1) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                try {
                    this.setState({ gpus: JSON.parse(line), gpuError: false });
                } catch (error) {
                    this.setState({ gpuError: true });
                }
            }
        });
        try {
            await process;
        } catch (error) {
            // Stopping a hidden page or changing privileges also closes the process.
        } finally {
            if (this.gpu_process === process) {
                this.gpu_process = null;
                if (this.gpu_active) {
                    this.setState({ gpus: [], gpuError: true });
                    this.gpu_timer = window.setTimeout(() => this.updateGpuMetrics(), 3000);
                }
            }
        }
    }

    onVisibilityChange() {
        if (cockpit.hidden) {
            this.stopGpuMetrics();
        } else if (!this.gpu_active) {
            this.gpu_active = true;
            this.updateGpuMetrics();
        }

        if (cockpit.hidden && this.metrics_channel !== null) {
            this.metrics_channel.removeEventListener("message", this.onMetricsUpdate);
            this.metrics_channel.close();
            this.metrics_channel = null;
            return;
        }

        if (!cockpit.hidden && this.metrics_channel === null) {
            this.metrics_channel = cockpit.channel(METRICS_SPEC);
            this.metrics_channel.addEventListener("closed", (ev, error) => console.error("metrics closed:", error));
            this.metrics_channel.addEventListener("message", this.onMetricsUpdate);
        }
    }

    onMetricsUpdate(event, message) {
        const data = JSON.parse(message);

        // reset state on meta messages
        if (!Array.isArray(data)) {
            this.samples = [];
            return;
        }

        // decompress
        data.forEach(samples => {
            samples.forEach((sample, i) => {
                if (sample !== null)
                    this.samples[i] = sample;
            });
        });

        // CPU metrics are in ms/s; divide by 10 to get percentage
        if (this.samples[0] !== false) {
            const cpu = Math.round((this.samples[0] + this.samples[1] + this.samples[2]) / 10 / this.state.numCpu);
            this.setState({ cpuUsed: cpu });
        }

        let used_text;
        if (this.state.memTotal) {
            const [total_fmt, unit] = cockpit.format_bytes(this.state.memTotal, { base2: true, separate: true, precision: 2 });
            // FIXME: passing explicit unit is deprecated, redesign this
            const used_fmt = cockpit.format_bytes(this.samples[3], unit, { separate: true, precision: 2 })[0];
            used_text = cockpit.format("$0 / $1 $2", used_fmt, total_fmt, unit);
        } else {
            used_text = " ";
        }

        this.setState({ memUsed: this.samples[3], memUsedText: used_text });
    }

    render() {
        const fraction = this.state.memTotal ? this.state.memUsed / this.state.memTotal : 0;
        const cores_str = cockpit.format(cockpit.ngettext("of $0 CPU", "of $0 CPUs", this.state.numCpu), this.state.numCpu);

        return (
            <Card className="system-usage">
                <CardTitle>{_("Usage")}</CardTitle>
                <CardBody>
                    <table className="pf-v6-c-table pf-m-grid-md pf-m-compact">
                        <tbody className="pf-v6-c-table__tbody">
                            <tr className="pf-v6-c-table__tr">
                                <th className="pf-v6-c-table__th" id="system-usage-cpu-progress" scope="row">{_("CPU")}</th>
                                <td className="pf-v6-c-table__td">
                                    <Progress value={this.state.cpuUsed}
                                        className="pf-m-sm"
                                        min={0} max={100}
                                        variant={ this.state.cpuUsed > 90 ? ProgressVariant.danger : undefined }
                                        label={ this.state.cpuUsed + '% ' + cores_str }
                                        aria-labelledby="system-usage-cpu-progress"
                                        measureLocation={ProgressMeasureLocation.outside} />
                                </td>
                            </tr>
                            <tr className="pf-v6-c-table__tr">
                                <th className="pf-v6-c-table__th" id="system-usage-memory-progress" scope="row">{_("Memory")}</th>
                                <td className="pf-v6-c-table__td">
                                    <Progress value={this.state.memUsed}
                                        className="pf-m-sm"
                                        min={0} max={this.state.memTotal}
                                        variant={fraction > 0.9 ? ProgressVariant.danger : undefined}
                                        aria-labelledby="system-usage-memory-progress"
                                        label={this.state.memUsedText}
                                        measureLocation={ProgressMeasureLocation.outside} />
                                </td>
                            </tr>
                            {this.state.gpus.map((gpu, index) => {
                                const id = "system-usage-gpu-" + index;
                                const busy = gpu.busy === null ? null : Math.min(100, gpu.busy);
                                const percent = gpu.total > 0 && gpu.used !== null
                                    ? Math.min(100, 100 * gpu.used / gpu.total)
                                    : gpu.vramPercent ?? null;
                                let memoryLabel = _("Unavailable");
                                if (gpu.used !== null && percent !== null) {
                                    memoryLabel = gpu.total > 0
                                        ? cockpit.format("$0 / $1", cockpit.format_bytes(gpu.used * 1048576, { base2: true }),
                                                         cockpit.format_bytes(gpu.total * 1048576, { base2: true }))
                                        : cockpit.format("$0 MiB ($1%)", Math.round(gpu.used), Math.round(percent));
                                }
                                let label = busy === null ? _("Utilization unavailable") : Math.round(busy) + "%";
                                if (gpu.temperature !== undefined && gpu.temperature !== null)
                                    label += " · " + cockpit.format(_("$0 °C"), Math.round(gpu.temperature));
                                return (
                                    <React.Fragment key={gpu.id}>
                                        <tr className="pf-v6-c-table__tr">
                                            <th className="pf-v6-c-table__th" id={id} scope="row" title={gpu.name}>
                                                {_("GPU")} {index}
                                            </th>
                                            <td className="pf-v6-c-table__td">
                                                {busy === null
                                                    ? <span>{label}</span>
                                                    : <Progress value={busy}
                                                        className="pf-m-sm"
                                                        min={0} max={100}
                                                        variant={busy > 90 ? ProgressVariant.danger : undefined}
                                                        label={label}
                                                        aria-labelledby={id}
                                                        measureLocation={ProgressMeasureLocation.outside} />}
                                            </td>
                                        </tr>
                                        <tr className="pf-v6-c-table__tr">
                                            <th className="pf-v6-c-table__th" id={id + "-memory"} scope="row" title={gpu.name}>
                                                {_("VRAM")} {index}
                                            </th>
                                            <td className="pf-v6-c-table__td">
                                                {percent === null
                                                    ? <span>{memoryLabel}</span>
                                                    : <Progress value={percent}
                                                        className="pf-m-sm"
                                                        min={0} max={100}
                                                        variant={percent > 90 ? ProgressVariant.danger : undefined}
                                                        label={memoryLabel}
                                                        aria-labelledby={id + "-memory"}
                                                        measureLocation={ProgressMeasureLocation.outside} />}
                                            </td>
                                        </tr>
                                    </React.Fragment>
                                );
                            })}
                            {this.state.gpuError &&
                                <tr className="pf-v6-c-table__tr">
                                    <th className="pf-v6-c-table__th" scope="row">{_("GPU")}</th>
                                    <td className="pf-v6-c-table__td">{_("GPU metrics unavailable")}</td>
                                </tr>}
                        </tbody>
                    </table>
                </CardBody>
                <CardFooter>
                    <Button isInline variant="link" component="a" onClick={ev => { ev.preventDefault(); cockpit.jump("/metrics", cockpit.transport.host) }}>
                        {_("View metrics and history")}
                    </Button>
                </CardFooter>
            </Card>
        );
    }
}
