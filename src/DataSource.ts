import defaults from 'lodash/defaults';

import { DataQueryRequest, DataQueryResponse, DataSourceApi, DataSourceInstanceSettings } from '@grafana/data';
import { BackendSrv } from '@grafana/runtime';
import { TemplateSrv } from 'types-grafana/app/features/templating/template_srv';

import { MyQuery, MyDataSourceOptions, defaultQuery } from './types';
import { MutableDataFrame, FieldType, DataFrame } from '@grafana/data';
import _ from 'lodash';
import { flatten } from './util';

export class DataSource extends DataSourceApi<MyQuery, MyDataSourceOptions> {
  basicAuth: string | undefined;
  withCredentials: boolean | undefined;
  url: string | undefined;

  constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>, private backendSrv: BackendSrv, private templateSrv: TemplateSrv) {
    super(instanceSettings);
    this.basicAuth = instanceSettings.basicAuth;
    this.withCredentials = instanceSettings.withCredentials;
    this.url = instanceSettings.url;
  }

  private async request(data: string) {
    const options: any = {
      url: this.url,
      method: 'POST',
      data: {
        query: data,
      },
    };

    if (this.basicAuth || this.withCredentials) {
      options.withCredentials = true;
    }
    if (this.basicAuth) {
      options.headers = {
        Authorization: this.basicAuth,
      };
    }

    return await this.backendSrv.datasourceRequest(options);
  }

  private async postQuery(query: Partial<MyQuery>, payload: string) {
    try {
      const results = await this.request(payload);
      return { query, results };
    } catch (err) {
      if (err.data && err.data.error) {
        throw {
          message: 'GraphQL error: ' + err.data.error.reason,
          error: err.data.error,
        };
      }

      throw err;
    }
  }

  // @ts-ignore
  flattenResults(results: any) {
    if (Array.isArray(results)) {
      // @ts-ignore
      const flat = results.map(r => this.flattenResults(r));
      if (flat.length === 1) {
        return flat[0];
      }
      if (Array.isArray(flat[0])) {
        return flat.flat();
      }
      return flat;
    }

    if (typeof results !== 'object') {
      return results;
    }

    const flattenedNonArray = {};
    let arrayKey: string | null = null;

    for (const key in results) {
      const value = results[key];
      if (Array.isArray(value)) {
        if (arrayKey != null) {
          console.error('Got multiple arrays in the object.');
        }
        arrayKey = key;
      } else {
        const flattenedValue = this.flattenResults(value);
        // @ts-ignore
        flattenedNonArray[key] = flattenedValue;
      }
    }

    if (!arrayKey) {
      return flattenedNonArray;
    }

    // @ts-ignore
    const flattenedArray = this.flattenResults(results[arrayKey]);
    // @ts-ignore
    return flattenedArray.map(aVal => {
      if (typeof aVal === 'object') {
        return {
          ...flattenedNonArray,
          ...aVal,
        };
      }
      // @ts-ignore
      flattenedNonArray[arrayKey] = aVal;
    });
  }

  async query(options: DataQueryRequest<MyQuery>): Promise<DataQueryResponse> {
    const results = await Promise.all(
      options.targets.map(async target => {
        const query = defaults(target, defaultQuery);
        let payload = query.queryText;
        if (options.range) {
          payload = payload.replace(/\$startTime/g, options.range.from.unix().toString());
          payload = payload.replace(/\$endTime/g, options.range.to.unix().toString());
        }
        payload = this.templateSrv.replace(payload, options.scopedVars);
        return await this.postQuery(query, payload);
      })
    );

    const dataFrame: DataFrame[] = [];
    for (const res of results) {
      const raw = res.query.dataPath?.split('.').reduce((d, p) => {
        return d[p];
      }, res.results.data);
      const data = this.flattenResults(raw);

      const docs: any[] = [];
      const fields: any[] = [];

      const pushDoc = (doc: object) => {
        // @ts-ignore
        const d = doc?.['node'] ? flatten(doc['node']) : flatten(doc);

        for (const p in d) {
          if (fields.indexOf(p) === -1) {
            fields.push(p);
          }
        }
        docs.push(d);
      };

      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          pushDoc(data[i]);
        }
      } else {
        pushDoc(data);
      }

      const df = new MutableDataFrame({
        fields: [],
      });
      for (const f of fields) {
        let t: FieldType = FieldType.string;
        if (_.isNumber(docs[0][f])) {
          t = FieldType.number;
        }
        df.addField({
          name: f,
          type: t,
        }).parse = (v: any) => {
          return v || '';
        };
      }
      for (const doc of docs) {
        if (doc?.Time) {
          doc.Time = doc.Time * 1000;
        }
        df.add(doc);
      }
      dataFrame.push(df);
    }

    return { data: dataFrame };
  }

  async testDatasource() {
    const q = `{
      __schema{
        queryType{name}
      }
    }`;
    try {
      await this.postQuery(defaultQuery, q);
      return {
        status: 'success',
        message: 'Success',
      };
    } catch (err) {
      console.log(err);
      return {
        status: 'error',
        message: 'HTTP Response ' + err.status + ': ' + err.statusText,
      };
    }
  }
}
