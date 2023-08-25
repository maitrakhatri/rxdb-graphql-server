import express from 'express';
import * as path from 'path';
const { graphqlHTTP } = require('express-graphql');
const cors = require('cors');
import { PubSub } from 'graphql-subscriptions';
import { buildSchema, execute, subscribe } from 'graphql';

import * as ws from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import { createServer } from 'http';

import {
    GRAPHQL_PORT,
    GRAPHQL_PATH,
    GRAPHQL_SUBSCRIPTION_PORT,
    GRAPHQL_SUBSCRIPTION_PATH,
    graphQLGenerationInput,
    JWT_BEARER_TOKEN,
} from '../shared';

import { graphQLSchemaFromRxSchema } from 'rxdb/plugins/replication-graphql';

import { lastOfArray } from 'rxdb';

function log(msg) {
    const prefix = '# GraphQL Server: ';
    if (typeof msg === 'string') {
        console.log(prefix + msg);
    } else {
        console.log(prefix + JSON.stringify(msg, null, 2));
    }
}

function sortByTimestampAndPrimary(a, b) {
    if (a.timestamp > b.timestamp) return 1;
    if (a.timestamp < b.timestamp) return -1;

    if (a.timestamp === b.timestamp) {
        if (a.id > b.id) return 1;
        if (a.id < b.id) return -1;
        else return 0;
    }
}

/**
 * Returns true if the request is authenticated
 * throws if not.
 * In a real world app you would parse and validate the bearer token.
 * @link https://graphql.org/graphql-js/authentication-and-express-middleware/
 */
export function authenticateRequest(request) {
    const authHeader = request.header('authorization');
    const splitted = authHeader.split(' ');
    const token = splitted[1];
    validateBearerToken(token);
}

export function validateBearerToken(token) {
    if (token === JWT_BEARER_TOKEN) {
        return true;
    } else {
        console.log('token not valid ' + token);
        throw new Error('not authenticated');
    }
}

export async function run() {
    let documents = [];
    const app = express();
    app.use(cors());

    /**
     * In this example we generate the GraphQL schema from the RxDB schema.
     * Of course you could also write it by hand or extend and existing one.
     */
    const generatedSchema = graphQLSchemaFromRxSchema(graphQLGenerationInput);
    const graphQLSchema = generatedSchema.asString;

    console.log('Server side GraphQL Schema:');
    console.log(graphQLSchema);
    const schema = buildSchema(graphQLSchema);

    const pubsub = new PubSub();

    // The root provides a resolver function for each API endpoint
    const root = {
        pullCollabdocs: (args, request) => {
            log('## pullCollabdocs()');
            log(args);
            // authenticateRequest(request);

            const lastId = args.checkpoint ? args.checkpoint.id : '';
            const mintimestamp = args.checkpoint
                ? args.checkpoint.timestamp
                : 0;

            // sorted by timestamp and primary
            const sortedDocuments = documents.sort(sortByTimestampAndPrimary);

            // only return where timestamp >= mintimestamp
            const filterForMintimestampAndId = sortedDocuments.filter((doc) => {
                if (!args.checkpoint) {
                    return true;
                }
                if (doc.timestamp < mintimestamp) {
                    return false;
                }
                if (doc.timestamp > mintimestamp) {
                    return true;
                }
                if (doc.timestamp === mintimestamp) {
                    if (doc.id > lastId) {
                        return true;
                    } else {
                        return false;
                    }
                }
            });

            // apply limit
            const limitedDocs = filterForMintimestampAndId.slice(0, args.limit);

            const last = lastOfArray(limitedDocs);
            const ret = {
                documents: limitedDocs,
                checkpoint: last
                    ? {
                          id: last.id,
                          timestamp: last.timestamp,
                      }
                    : {
                          id: lastId,
                          timestamp: mintimestamp,
                      },
            };
            console.log('pullCollabdocs() ret:');
            console.log(JSON.stringify(ret, null, 4));
            return ret;
        },
        pushCollabdocs: (args, request) => {
            log('## pushCollabdocs()');
            log(args);
            // authenticateRequest(request);

            const rows = args.CollabdocsPushRow;
            let lastCheckpoint = {
                id: '',
                timestamp: 0,
            };

            const conflicts = [];

            const writtenDocs = [];
            rows.forEach((row) => {
                const docId = row.newDocumentState.id;
                const docCurrentMaster = documents.find((d) => d.id === docId);

                /**
                 * Detect conflicts.
                 */
                if (
                    docCurrentMaster &&
                    row.assumedMasterState &&
                    docCurrentMaster.timestamp !==
                        row.assumedMasterState.timestamp
                ) {
                    conflicts.push(docCurrentMaster);
                    return;
                }

                const doc = row.newDocumentState;
                documents = documents.filter((d) => d.id !== doc.id);
                documents.push(doc);

                lastCheckpoint.id = doc.id;
                lastCheckpoint.timestamp = doc.timestamp;
                writtenDocs.push(doc);
            });

            pubsub.publish('streamHero', {
                streamHero: {
                    documents: writtenDocs,
                    checkpoint: lastCheckpoint,
                },
            });

            console.log('## current documents:');
            console.log(JSON.stringify(documents, null, 4));
            console.log('## conflicts:');
            console.log(JSON.stringify(conflicts, null, 4));

            return conflicts;
        },
        streamHero: (args) => {
            log('## streamHero()');

            console.dir(args);
            const authHeaderValue = args.headers.Authorization;
            const bearerToken = authHeaderValue.split(' ')[1];

            validateBearerToken(bearerToken);

            return pubsub.asyncIterator('streamHero');
        },
    };

    // server multitab.html - used in the e2e test
    app.use('/static', express.static(path.join(__dirname, '/static')));

    // server graphql-endpoint
    app.use(
        GRAPHQL_PATH,
        graphqlHTTP({
            schema: schema,
            rootValue: root,
            graphiql: true,
        })
    );

    app.listen(GRAPHQL_PORT, function () {
        log(
            'Started graphql-endpoint at http://localhost:' +
                GRAPHQL_PORT +
                GRAPHQL_PATH
        );
    });

    const appSubscription = express();
    appSubscription.use(cors);
    const serverSubscription = createServer(appSubscription);
    serverSubscription.listen(GRAPHQL_SUBSCRIPTION_PORT, () => {
        log(
            'Started graphql-subscription endpoint at http://localhost:' +
                GRAPHQL_SUBSCRIPTION_PORT +
                GRAPHQL_SUBSCRIPTION_PATH
        );
        const wsServer = new ws.Server({
            server: serverSubscription,
            path: GRAPHQL_SUBSCRIPTION_PATH,
        });

        const subServer = useServer(
            {
                schema,
                execute,
                subscribe,
                roots: {
                    subscription: {
                        streamHero: root.streamHero,
                    },
                },
            },
            wsServer
        );
        return subServer;
    });

    // comment this in for testing of the subscriptions
    /* setInterval(() => {
        const flag = new Date().getTime();
        pubsub.publish('streamHero', {
            streamHero: {
                documents: [{
                    id: 'foobar-' + flag,
                    name: 'name-' + flag,
                    color: 'green',
                    timestamp: flag,
                    deleted: false
                }],
                checkpoint: {
                    id: 'foobar-' + flag,
                    timestamp: flag
                },
            },
        });
        console.log('published streamHero ' + flag);
    }, 1000); */
}

run();
