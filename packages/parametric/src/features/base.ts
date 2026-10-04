// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type I18nKeys, type IShape, Result } from "@chili3d/core";
import { type BaseFeatureData, type FeatureContext, type FeatureHandler, registerFeature } from "./feature";

/** The handler of a `base` feature: the stored BRep is the body's starting shape. */
const baseHandler: FeatureHandler<BaseFeatureData> = {
    display: "common.name" as I18nKeys,
    nodeIds: () => [],
    parameters: () => [],
    setParameter: (feature) => feature,
    evaluate(feature: BaseFeatureData, _context: FeatureContext): Result<IShape> {
        const r = shapeConverter.convertFromBrep(feature.brep);
        return r.isOk
            ? Result.ok(r.value)
            : Result.err(`the imported shape could not be read back: ${r.error}`);
    },
};
registerFeature("base", baseHandler);
