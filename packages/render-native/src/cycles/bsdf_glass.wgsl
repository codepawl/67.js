/* SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
 * SPDX-FileCopyrightText: 2011-2026 Blender Foundation
 *
 * SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
 *
 * Adapted code from Open Shading Language and Blender Cycles
 * (kernel/closure/bsdf_microfacet.h, kernel/closure/bsdf_util.h). */

const BSDF_GLASS_INV_255: f32 = 0.00392156862745098;
const BSDF_GLASS_INV_65535: f32 = 1.5259021896696422e-5;
const BSDF_GLASS_SINGULAR_WEIGHT: f32 = 1e6;

fn bsdf_glass_lut_e_u32(word_idx: u32) -> u32 {
  let vec_idx = word_idx >> 2u;
  let lane = word_idx & 3u;
  var v = vec4<u32>(0u);
  switch (vec_idx >> 6u) {
    case 0u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfffffeffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xfffffeffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 3u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 4u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 5u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 6u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 7u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 8u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 9u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 10u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 11u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 12u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 13u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 14u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 15u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 16u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 17u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 18u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 19u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 20u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 21u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 23u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 25u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 27u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 29u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 31u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 33u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 35u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 37u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 39u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 41u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 43u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 45u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 47u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 49u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 51u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 53u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 55u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 57u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 59u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 61u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        default: {}
      }
    }
    case 1u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xfcfdfdfeu, 0xf9fafafbu, 0xf5f6f7f8u); }
        case 1u: { v = vec4<u32>(0xf1f2f3f4u, 0xedeeeff0u, 0xe8e9eaecu, 0xe4e5e6e7u); }
        case 2u: { v = vec4<u32>(0xf9f4e5ffu, 0xeff3f6f9u, 0xe1e4e8ecu, 0xd3d6daddu); }
        case 3u: { v = vec4<u32>(0xc8cbcdd0u, 0xbec1c3c5u, 0xb6b8babcu, 0xb0b1b3b5u); }
        case 4u: { v = vec4<u32>(0xefe8f7ffu, 0xdfe6edf0u, 0xc5cbd1d8u, 0xb3b7bbc0u); }
        case 5u: { v = vec4<u32>(0xa7aaadb0u, 0x9fa1a3a5u, 0x999a9c9du, 0x94959698u); }
        case 6u: { v = vec4<u32>(0xecf1feffu, 0xd6e0e8ecu, 0xb6bdc4cdu, 0xa4a8acb1u); }
        case 7u: { v = vec4<u32>(0x9a9c9ea1u, 0x93949698u, 0x8f909192u, 0x8b8c8d8eu); }
        case 8u: { v = vec4<u32>(0xf1faffffu, 0xd5dfe8edu, 0xb1b8c0cau, 0x9ea2a6abu); }
        case 9u: { v = vec4<u32>(0x9496999bu, 0x8e909192u, 0x8b8b8c8du, 0x8889898au); }
        case 10u: { v = vec4<u32>(0xf8fdffffu, 0xd8e3ebf2u, 0xb1b9c2cdu, 0x9da1a5abu); }
        case 11u: { v = vec4<u32>(0x9395979au, 0x8d8e9091u, 0x8a8a8b8cu, 0x87888889u); }
        case 12u: { v = vec4<u32>(0xfcfeffffu, 0xdee8f0f7u, 0xb6bec8d3u, 0x9fa3a9afu); }
        case 13u: { v = vec4<u32>(0x9496999cu, 0x8e8f9092u, 0x8a8b8c8cu, 0x87888889u); }
        case 14u: { v = vec4<u32>(0xfdffffffu, 0xe5edf5fau, 0xbdc6d0dau, 0xa4a8aeb5u); }
        case 15u: { v = vec4<u32>(0x97999c9fu, 0x8f919294u, 0x8b8c8d8eu, 0x88898a8au); }
        case 16u: { v = vec4<u32>(0xfeffffffu, 0xebf2f8fcu, 0xc5ced8e2u, 0xa9afb5bcu); }
        case 17u: { v = vec4<u32>(0x9a9da1a5u, 0x92949698u, 0x8d8e8f91u, 0x8a8a8b8cu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xcdd6e0e8u, 0xb0b6bdc5u); }
        case 19u: { v = vec4<u32>(0x9fa3a6abu, 0x95979a9cu, 0x8f919294u, 0x8c8c8d8eu); }
        case 20u: { v = vec4<u32>(0xffffffffu, 0xf4f9fcfeu, 0xd6dee6eeu, 0xb8bec5cdu); }
        case 21u: { v = vec4<u32>(0xa5a9adb2u, 0x999c9ea1u, 0x92949597u, 0x8e8f9091u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xdde5ecf2u, 0xbfc6cdd5u); }
        case 23u: { v = vec4<u32>(0xabafb4b9u, 0x9ea0a3a7u, 0x9697999bu, 0x90929394u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe4eaf0f5u, 0xc7ced5dcu); }
        case 25u: { v = vec4<u32>(0xb1b6bbc1u, 0xa3a6a9adu, 0x999b9ea0u, 0x93959698u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe9eff4f7u, 0xcfd5dce3u); }
        case 27u: { v = vec4<u32>(0xb8bdc2c8u, 0xa8abafb3u, 0x9ea0a2a5u, 0x97989a9cu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd6dce2e8u); }
        case 29u: { v = vec4<u32>(0xbfc4c9cfu, 0xaeb1b5bau, 0xa2a4a7aau, 0x9a9c9ea0u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf1f5f8fbu, 0xdce2e7ecu); }
        case 31u: { v = vec4<u32>(0xc5cbd0d6u, 0xb3b7bcc0u, 0xa7a9acb0u, 0x9ea0a2a4u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f7fafcu, 0xe1e7ecf0u); }
        case 33u: { v = vec4<u32>(0xccd1d7dcu, 0xb9bec2c7u, 0xacafb2b6u, 0xa2a4a6a9u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f9fbfcu, 0xe6ebeff3u); }
        case 35u: { v = vec4<u32>(0xd2d7dce1u, 0xbfc4c8cdu, 0xb1b4b8bbu, 0xa6a8abaeu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xebeff2f5u); }
        case 37u: { v = vec4<u32>(0xd8dde2e6u, 0xc5caced3u, 0xb6babdc1u, 0xabadb0b3u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeef2f5f7u); }
        case 39u: { v = vec4<u32>(0xdde2e6eau, 0xcbd0d4d9u, 0xbcbfc3c7u, 0xb0b2b5b8u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf1f4f7f9u); }
        case 41u: { v = vec4<u32>(0xe2e6eaeeu, 0xd1d6dadeu, 0xc2c5c9cdu, 0xb5b8bbbeu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf4f6f8fau); }
        case 43u: { v = vec4<u32>(0xe7eaeef1u, 0xd7dbdfe3u, 0xc7cbcfd3u, 0xbabdc0c4u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 45u: { v = vec4<u32>(0xebeef1f4u, 0xdce0e4e7u, 0xcdd1d5d9u, 0xc0c3c6cau); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf8f9fbfcu); }
        case 47u: { v = vec4<u32>(0xeef1f4f6u, 0xe1e5e8ebu, 0xd3d7dadeu, 0xc6c9ccd0u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe6e9ecefu, 0xd9dde0e3u, 0xcccfd2d6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfcfdu); }
        case 51u: { v = vec4<u32>(0xf4f6f8f9u, 0xebedf0f2u, 0xdfe2e5e8u, 0xd2d6d9dcu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 53u: { v = vec4<u32>(0xf7f8fafbu, 0xeff1f3f5u, 0xe5e7eaedu, 0xd9dcdfe2u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfdfdfefeu); }
        case 55u: { v = vec4<u32>(0xf9fafbfcu, 0xf3f5f6f8u, 0xeaedeff1u, 0xe0e3e5e8u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 57u: { v = vec4<u32>(0xfbfcfcfdu, 0xf6f8f9fau, 0xf0f2f3f5u, 0xe7eaeceeu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 59u: { v = vec4<u32>(0xfcfdfdfeu, 0xf9fafbfcu, 0xf5f6f7f9u, 0xeff1f2f4u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 61u: { v = vec4<u32>(0xfefefefeu, 0xfcfdfdfdu, 0xfafbfbfcu, 0xf7f8f9f9u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        default: {}
      }
    }
    case 2u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xfefefeffu, 0xfdfdfefeu, 0xfcfcfcfdu); }
        case 1u: { v = vec4<u32>(0xfafafbfbu, 0xf8f9f9f9u, 0xf6f7f7f8u, 0xf4f5f5f6u); }
        case 2u: { v = vec4<u32>(0xfaf4e4ffu, 0xfafbfbfbu, 0xf3f5f7f8u, 0xeceeeff1u); }
        case 3u: { v = vec4<u32>(0xe5e6e8eau, 0xdedfe1e3u, 0xd7d9dadcu, 0xd1d3d4d6u); }
        case 4u: { v = vec4<u32>(0xeee6f7ffu, 0xf2f4f5f4u, 0xe3e7ebefu, 0xd5d8dce0u); }
        case 5u: { v = vec4<u32>(0xc9cccfd2u, 0xbfc1c4c6u, 0xb7b8bbbdu, 0xb0b1b3b5u); }
        case 6u: { v = vec4<u32>(0xe9effdffu, 0xeceff0edu, 0xd7dde2e8u, 0xc5c9cdd2u); }
        case 7u: { v = vec4<u32>(0xb7babdc1u, 0xacafb1b4u, 0xa4a6a8aau, 0x9ea0a1a3u); }
        case 8u: { v = vec4<u32>(0xeef8ffffu, 0xe9ececebu, 0xd0d6dde3u, 0xbabfc4cau); }
        case 9u: { v = vec4<u32>(0xacafb2b6u, 0xa2a4a6a9u, 0x9b9c9ea0u, 0x95979899u); }
        case 10u: { v = vec4<u32>(0xf5fdffffu, 0xe7ebedefu, 0xcdd4dbe2u, 0xb5babfc6u); }
        case 11u: { v = vec4<u32>(0xa6a9acb0u, 0x9c9ea0a3u, 0x9597989au, 0x91929394u); }
        case 12u: { v = vec4<u32>(0xfafeffffu, 0xe9edf0f4u, 0xccd4dce3u, 0xb3b8bec5u); }
        case 13u: { v = vec4<u32>(0xa3a6aaaeu, 0x999b9ea0u, 0x93949697u, 0x8f909192u); }
        case 14u: { v = vec4<u32>(0xfdffffffu, 0xebf0f4f9u, 0xcfd7dfe6u, 0xb4bac0c7u); }
        case 15u: { v = vec4<u32>(0xa3a6aaafu, 0x999b9da0u, 0x92949597u, 0x8e8f9091u); }
        case 16u: { v = vec4<u32>(0xfeffffffu, 0xeff3f8fbu, 0xd3dbe2e9u, 0xb7bdc4cbu); }
        case 17u: { v = vec4<u32>(0xa4a8acb1u, 0x9a9c9ea1u, 0x93949698u, 0x8e8f9091u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf2f7fafdu, 0xd8dfe7edu, 0xbbc1c8d0u); }
        case 19u: { v = vec4<u32>(0xa7abb0b5u, 0x9c9ea1a4u, 0x94969799u, 0x8f909193u); }
        case 20u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xdde4ebf1u, 0xc0c7ced6u); }
        case 21u: { v = vec4<u32>(0xacb0b5bau, 0x9ea1a4a8u, 0x96989a9cu, 0x91929395u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xe2e9eff4u, 0xc6cdd4dbu); }
        case 23u: { v = vec4<u32>(0xb0b5bac0u, 0xa2a5a8acu, 0x999b9d9fu, 0x93949597u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xfafcfdfeu, 0xe7edf2f6u, 0xcdd3dae1u); }
        case 25u: { v = vec4<u32>(0xb6bbc0c6u, 0xa6aaadb1u, 0x9c9ea1a3u, 0x9597989au); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f5f8u, 0xd3d9e0e6u); }
        case 27u: { v = vec4<u32>(0xbcc1c6ccu, 0xabafb2b7u, 0xa0a2a5a8u, 0x989a9c9eu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xeff3f7fau, 0xd9dfe5eau); }
        case 29u: { v = vec4<u32>(0xc2c7cdd3u, 0xb0b4b8bdu, 0xa4a6a9adu, 0x9b9d9fa1u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf2f6f9fbu, 0xdee4e9eeu); }
        case 31u: { v = vec4<u32>(0xc8cdd3d8u, 0xb5babec3u, 0xa8abaeb2u, 0x9fa1a3a6u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f8fafcu, 0xe3e8edf1u); }
        case 33u: { v = vec4<u32>(0xced3d8deu, 0xbbbfc4c9u, 0xadb0b3b7u, 0xa3a5a7aau); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xe8ecf0f4u); }
        case 35u: { v = vec4<u32>(0xd4d9dee3u, 0xc1c5cacfu, 0xb2b5b9bdu, 0xa7a9acafu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xebeff3f6u); }
        case 37u: { v = vec4<u32>(0xd9dee3e7u, 0xc7cbd0d4u, 0xb7bbbec2u, 0xabaeb1b4u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xfafbfcfdu, 0xeff2f5f8u); }
        case 39u: { v = vec4<u32>(0xdee3e7ebu, 0xccd1d5dau, 0xbdc0c4c8u, 0xb0b3b6b9u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf2f4f7f9u); }
        case 41u: { v = vec4<u32>(0xe3e7ebeeu, 0xd2d6dbdfu, 0xc2c6caceu, 0xb5b8bbbfu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu, 0xf4f6f8fau); }
        case 43u: { v = vec4<u32>(0xe7ebeef1u, 0xd8dce0e3u, 0xc8ccd0d3u, 0xbabec1c4u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 45u: { v = vec4<u32>(0xebeef1f4u, 0xdde1e4e8u, 0xced1d5d9u, 0xc0c3c7cau); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf8f9fbfcu); }
        case 47u: { v = vec4<u32>(0xeff1f4f6u, 0xe2e5e9ecu, 0xd4d7dbdeu, 0xc6c9cdd0u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaecefu, 0xd9dde0e3u, 0xcccfd3d6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfcfdu); }
        case 51u: { v = vec4<u32>(0xf4f6f8f9u, 0xebeef0f2u, 0xdfe2e5e8u, 0xd2d6d9dcu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 53u: { v = vec4<u32>(0xf7f8fafbu, 0xeff1f3f5u, 0xe5e7eaedu, 0xd9dcdfe2u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfdfdfefeu); }
        case 55u: { v = vec4<u32>(0xf9fafbfcu, 0xf3f5f6f8u, 0xeaedeff1u, 0xe0e3e5e8u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 57u: { v = vec4<u32>(0xfbfbfcfdu, 0xf6f8f9fau, 0xf0f2f3f5u, 0xe7eaeceeu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 59u: { v = vec4<u32>(0xfcfdfdfeu, 0xf9fafbfcu, 0xf5f6f7f8u, 0xeff0f2f4u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 61u: { v = vec4<u32>(0xfefefefeu, 0xfcfdfdfdu, 0xfafbfbfcu, 0xf7f8f8f9u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        default: {}
      }
    }
    case 3u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xfefefefeu, 0xfdfdfefeu); }
        case 1u: { v = vec4<u32>(0xfcfdfdfdu, 0xfbfcfcfcu, 0xfafbfbfbu, 0xf9f9fafau); }
        case 2u: { v = vec4<u32>(0xfaf3e4ffu, 0xfcfcfcfcu, 0xf9fafbfbu, 0xf4f5f6f8u); }
        case 3u: { v = vec4<u32>(0xeff1f2f3u, 0xebecedeeu, 0xe6e7e8eau, 0xe1e2e4e5u); }
        case 4u: { v = vec4<u32>(0xeee5f6ffu, 0xf7f8f7f4u, 0xeff2f4f6u, 0xe5e7eaedu); }
        case 5u: { v = vec4<u32>(0xdbdde0e2u, 0xd2d4d6d9u, 0xcaccced0u, 0xc3c5c7c8u); }
        case 6u: { v = vec4<u32>(0xe7eefdffu, 0xf2f2f1ecu, 0xe7eaeef0u, 0xd7dbdfe3u); }
        case 7u: { v = vec4<u32>(0xcacdd1d4u, 0xc0c2c5c8u, 0xb7b9bbbdu, 0xb0b1b3b5u); }
        case 8u: { v = vec4<u32>(0xecf8ffffu, 0xeeeeece9u, 0xe0e5e9ecu, 0xced2d7dcu); }
        case 9u: { v = vec4<u32>(0xbfc2c6cau, 0xb3b6b8bbu, 0xaaacaeb1u, 0xa3a5a7a8u); }
        case 10u: { v = vec4<u32>(0xf4fcffffu, 0xececebedu, 0xdde2e7eau, 0xc7ccd2d7u); }
        case 11u: { v = vec4<u32>(0xb7babec3u, 0xabaeb0b3u, 0xa2a4a6a9u, 0x9c9d9fa1u); }
        case 12u: { v = vec4<u32>(0xf9feffffu, 0xebeceef3u, 0xdbe1e6e9u, 0xc4c9cfd5u); }
        case 13u: { v = vec4<u32>(0xb2b6babfu, 0xa6a9abafu, 0x9e9fa1a4u, 0x97999a9cu); }
        case 14u: { v = vec4<u32>(0xfcfeffffu, 0xedeff3f8u, 0xdbe1e6eau, 0xc3c9cfd5u); }
        case 15u: { v = vec4<u32>(0xb0b4b8bdu, 0xa3a6a9acu, 0x9b9d9fa1u, 0x95969899u); }
        case 16u: { v = vec4<u32>(0xfeffffffu, 0xeff3f7fbu, 0xdde3e8ecu, 0xc4cad0d7u); }
        case 17u: { v = vec4<u32>(0xb0b4b9beu, 0xa3a5a9acu, 0x9a9c9ea0u, 0x94959798u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf2f6fafdu, 0xe0e6eaefu, 0xc6ccd3d9u); }
        case 19u: { v = vec4<u32>(0xb1b6bbc0u, 0xa3a6a9adu, 0x9a9c9ea1u, 0x94959798u); }
        case 20u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xe3e9edf2u, 0xcad0d6ddu); }
        case 21u: { v = vec4<u32>(0xb4b9bec3u, 0xa5a8acafu, 0x9b9da0a2u, 0x95969899u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xe7ecf0f4u, 0xced4dbe1u); }
        case 23u: { v = vec4<u32>(0xb7bcc2c8u, 0xa8abafb3u, 0x9d9fa2a5u, 0x9698999bu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xfafcfdfeu, 0xeaeff3f7u, 0xd2d9dfe5u); }
        case 25u: { v = vec4<u32>(0xbcc1c6ccu, 0xabafb3b7u, 0xa0a2a5a8u, 0x989a9b9du); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xedf2f6f9u, 0xd7dde3e9u); }
        case 27u: { v = vec4<u32>(0xc0c6cbd1u, 0xafb3b7bcu, 0xa3a5a8abu, 0x9a9c9ea0u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf0f4f7fau, 0xdce2e7ecu); }
        case 29u: { v = vec4<u32>(0xc6cbd1d6u, 0xb3b7bcc1u, 0xa6a9acb0u, 0x9d9fa1a4u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf3f6f9fbu, 0xe1e6ebefu); }
        case 31u: { v = vec4<u32>(0xcbd0d6dbu, 0xb8bdc1c6u, 0xaaadb1b4u, 0xa0a3a5a8u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xe5eaeef2u); }
        case 33u: { v = vec4<u32>(0xd0d6dbe0u, 0xbdc2c6cbu, 0xafb2b6b9u, 0xa4a6a9acu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xe9edf1f4u); }
        case 35u: { v = vec4<u32>(0xd6dbe0e4u, 0xc3c7ccd1u, 0xb3b7bbbfu, 0xa8abadb0u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fafcfdu, 0xecf0f3f6u); }
        case 37u: { v = vec4<u32>(0xdbdfe4e8u, 0xc8cdd1d6u, 0xb8bcc0c4u, 0xacafb2b5u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfdu, 0xeff3f5f8u); }
        case 39u: { v = vec4<u32>(0xdfe4e8ecu, 0xced2d6dbu, 0xbec1c5c9u, 0xb1b4b7bau); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf2f5f7f9u); }
        case 41u: { v = vec4<u32>(0xe4e8ecefu, 0xd3d7dce0u, 0xc3c7cbcfu, 0xb6b9bcbfu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu, 0xf4f7f9fau); }
        case 43u: { v = vec4<u32>(0xe8ebeff2u, 0xd8dce0e4u, 0xc9ccd0d4u, 0xbbbec1c5u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 45u: { v = vec4<u32>(0xeceff2f4u, 0xdde1e5e8u, 0xced2d6dau, 0xc0c4c7cbu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 47u: { v = vec4<u32>(0xeff2f4f6u, 0xe2e6e9ecu, 0xd4d7dbdfu, 0xc6c9cdd0u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedefu, 0xdadde0e4u, 0xcccfd3d6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfcfdu); }
        case 51u: { v = vec4<u32>(0xf4f6f8f9u, 0xebeef0f2u, 0xdfe2e5e8u, 0xd2d6d9dcu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 53u: { v = vec4<u32>(0xf7f8fafbu, 0xeff1f3f5u, 0xe5e7eaedu, 0xd9dcdfe2u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfdfdfefeu); }
        case 55u: { v = vec4<u32>(0xf9fafbfcu, 0xf3f5f6f8u, 0xeaedeff1u, 0xe0e3e5e8u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 57u: { v = vec4<u32>(0xfbfbfcfdu, 0xf6f7f9fau, 0xf0f1f3f5u, 0xe7e9ebeeu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 59u: { v = vec4<u32>(0xfcfdfdfeu, 0xf9fafbfcu, 0xf5f6f7f8u, 0xeef0f2f3u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 61u: { v = vec4<u32>(0xfefefefeu, 0xfcfdfdfdu, 0xfafafbfcu, 0xf6f7f8f9u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefefeu, 0xfdfefefeu); }
        default: {}
      }
    }
    case 4u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xfefeffffu, 0xfefefefeu); }
        case 1u: { v = vec4<u32>(0xfdfdfefeu, 0xfdfdfdfdu, 0xfcfcfcfdu, 0xfbfbfcfcu); }
        case 2u: { v = vec4<u32>(0xfaf3e4ffu, 0xfdfdfdfcu, 0xfbfcfcfdu, 0xf8f9fafau); }
        case 3u: { v = vec4<u32>(0xf5f6f6f7u, 0xf1f2f3f4u, 0xeeefeff0u, 0xeaebecedu); }
        case 4u: { v = vec4<u32>(0xede5f6ffu, 0xf9f9f7f4u, 0xf5f6f7f8u, 0xedeff1f3u); }
        case 5u: { v = vec4<u32>(0xe5e7e9ebu, 0xdee0e2e3u, 0xd7d9dadcu, 0xd1d2d4d5u); }
        case 6u: { v = vec4<u32>(0xe6edfdffu, 0xf4f3f1ecu, 0xeef1f3f4u, 0xe3e6e9ecu); }
        case 7u: { v = vec4<u32>(0xd7dadde0u, 0xcdd0d2d5u, 0xc5c7c9cbu, 0xbdbfc1c3u); }
        case 8u: { v = vec4<u32>(0xebf7ffffu, 0xf0efebe8u, 0xe9eceff0u, 0xdadee2e6u); }
        case 9u: { v = vec4<u32>(0xccd0d3d7u, 0xc1c4c6c9u, 0xb7babcbeu, 0xb0b2b3b5u); }
        case 10u: { v = vec4<u32>(0xf3fcffffu, 0xedeceaebu, 0xe6e9ecedu, 0xd4d9dde2u); }
        case 11u: { v = vec4<u32>(0xc4c8ccd0u, 0xb8bbbec1u, 0xaeb0b3b5u, 0xa7a8aaacu); }
        case 12u: { v = vec4<u32>(0xf9feffffu, 0xececedf1u, 0xe4e7eaecu, 0xd0d5dadfu); }
        case 13u: { v = vec4<u32>(0xbfc3c7ccu, 0xb2b5b8bbu, 0xa8aaacafu, 0xa0a2a4a6u); }
        case 14u: { v = vec4<u32>(0xfcfeffffu, 0xeceef1f7u, 0xe3e7eaebu, 0xced4d9deu); }
        case 15u: { v = vec4<u32>(0xbcc0c4c9u, 0xaeb1b4b8u, 0xa4a6a8abu, 0x9c9ea0a2u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeff1f5fau, 0xe3e7eaedu, 0xced4d9dfu); }
        case 17u: { v = vec4<u32>(0xbabfc4c9u, 0xacafb2b6u, 0xa2a4a6a9u, 0x9a9c9e9fu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf2f5f9fcu, 0xe5e9ecefu, 0xcfd5dbe0u); }
        case 19u: { v = vec4<u32>(0xbbbfc4cau, 0xabafb2b6u, 0xa1a3a5a8u, 0x999b9d9fu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf5f8fbfdu, 0xe7ebeef2u, 0xd1d7dde2u); }
        case 21u: { v = vec4<u32>(0xbcc1c6ccu, 0xacafb3b7u, 0xa1a3a6a9u, 0x999b9d9fu); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf7fafcfeu, 0xe9edf1f4u, 0xd4dae0e5u); }
        case 23u: { v = vec4<u32>(0xbec4c9cfu, 0xaeb1b5bau, 0xa2a4a7aau, 0x9a9c9da0u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xecf0f4f7u, 0xd8dde3e8u); }
        case 25u: { v = vec4<u32>(0xc2c7ccd2u, 0xb0b4b8bdu, 0xa4a6a9adu, 0x9b9d9fa1u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xeff3f6f9u, 0xdce1e6ebu); }
        case 27u: { v = vec4<u32>(0xc6cbd0d6u, 0xb3b7bcc1u, 0xa6a9acb0u, 0x9d9fa1a4u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf1f5f8fau, 0xdfe5e9eeu); }
        case 29u: { v = vec4<u32>(0xcacfd5dau, 0xb7bbc0c5u, 0xa9acb0b3u, 0x9fa2a4a7u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f7f9fbu, 0xe3e8ecf0u); }
        case 31u: { v = vec4<u32>(0xced4d9deu, 0xbcc0c5c9u, 0xadb0b4b7u, 0xa2a5a7aau); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xe7ebeff3u); }
        case 33u: { v = vec4<u32>(0xd3d8dde2u, 0xc0c5c9ceu, 0xb1b4b8bcu, 0xa6a8abaeu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafbfdu, 0xeaeef2f5u); }
        case 35u: { v = vec4<u32>(0xd8dde1e6u, 0xc5c9ced3u, 0xb5b9bdc1u, 0xa9acafb2u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xedf1f4f7u); }
        case 37u: { v = vec4<u32>(0xdce1e5e9u, 0xcaced3d8u, 0xbabec2c6u, 0xadb0b3b6u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xf0f3f6f8u); }
        case 39u: { v = vec4<u32>(0xe1e5e9edu, 0xcfd3d8dcu, 0xbfc3c7cbu, 0xb2b5b8bbu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f5f7f9u); }
        case 41u: { v = vec4<u32>(0xe5e9ecf0u, 0xd4d8dde1u, 0xc4c8ccd0u, 0xb6b9bdc0u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu, 0xf5f7f9fau); }
        case 43u: { v = vec4<u32>(0xe9eceff2u, 0xd9dde1e5u, 0xc9cdd1d5u, 0xbbbfc2c6u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 45u: { v = vec4<u32>(0xeceff2f4u, 0xdee2e5e9u, 0xcfd2d6dau, 0xc1c4c7cbu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 47u: { v = vec4<u32>(0xeff2f4f6u, 0xe3e6e9ecu, 0xd4d8dbdfu, 0xc6cacdd1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedf0u, 0xdadde1e4u, 0xcccfd3d6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfcfdu); }
        case 51u: { v = vec4<u32>(0xf5f6f8f9u, 0xebeef0f3u, 0xdfe2e5e8u, 0xd2d6d9dcu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 53u: { v = vec4<u32>(0xf7f8fafbu, 0xeff1f3f5u, 0xe5e7eaedu, 0xd9dcdfe2u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfefeu); }
        case 55u: { v = vec4<u32>(0xf9fafbfcu, 0xf3f4f6f8u, 0xeaeceff1u, 0xdfe2e5e8u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 57u: { v = vec4<u32>(0xfbfbfcfdu, 0xf6f7f9fau, 0xeff1f3f5u, 0xe7e9ebedu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 59u: { v = vec4<u32>(0xfcfdfdfeu, 0xf9fafbfcu, 0xf4f6f7f8u, 0xeef0f1f3u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 61u: { v = vec4<u32>(0xfefefefeu, 0xfcfcfdfdu, 0xf9fafbfbu, 0xf5f6f7f8u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xffffffffu, 0xfefefeffu, 0xfdfefefeu, 0xfcfdfdfdu); }
        default: {}
      }
    }
    case 5u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 1u: { v = vec4<u32>(0xfefefefeu, 0xfdfdfefeu, 0xfdfdfdfdu, 0xfcfcfdfdu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfdfdfdfcu, 0xfcfdfdfdu, 0xfafbfbfcu); }
        case 3u: { v = vec4<u32>(0xf8f8f9f9u, 0xf5f6f6f7u, 0xf2f3f4f4u, 0xeff0f1f1u); }
        case 4u: { v = vec4<u32>(0xede5f6ffu, 0xfaf9f7f4u, 0xf7f8f9fau, 0xf2f3f5f6u); }
        case 5u: { v = vec4<u32>(0xecedeff0u, 0xe6e7e9eau, 0xe0e1e3e4u, 0xdadbdddeu); }
        case 6u: { v = vec4<u32>(0xe6edfdffu, 0xf5f4f0ebu, 0xf3f4f5f6u, 0xeaeceef1u); }
        case 7u: { v = vec4<u32>(0xe0e3e5e7u, 0xd7d9dcdeu, 0xcfd1d3d5u, 0xc8cacbcdu); }
        case 8u: { v = vec4<u32>(0xeaf7ffffu, 0xf1efebe8u, 0xeef0f2f2u, 0xe3e6e9ecu); }
        case 9u: { v = vec4<u32>(0xd6d9dce0u, 0xcbced1d3u, 0xc2c4c7c9u, 0xbabcbec0u); }
        case 10u: { v = vec4<u32>(0xf2fcffffu, 0xeeebe9eau, 0xebedefefu, 0xdde1e5e8u); }
        case 11u: { v = vec4<u32>(0xcfd2d6d9u, 0xc2c5c8cbu, 0xb8bbbdc0u, 0xb0b2b4b6u); }
        case 12u: { v = vec4<u32>(0xf8feffffu, 0xecebecf0u, 0xe9ebecedu, 0xd9dee2e5u); }
        case 13u: { v = vec4<u32>(0xc9cdd1d5u, 0xbcbfc2c5u, 0xb1b3b6b9u, 0xa9abadafu); }
        case 14u: { v = vec4<u32>(0xfcfeffffu, 0xecedf0f6u, 0xe7eaebecu, 0xd7dce0e4u); }
        case 15u: { v = vec4<u32>(0xc5caced2u, 0xb7babec1u, 0xacafb1b4u, 0xa4a6a8aau); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeef0f5fau, 0xe7eaebedu, 0xd6dbe0e4u); }
        case 17u: { v = vec4<u32>(0xc3c8ccd1u, 0xb4b8bbbfu, 0xa9abaeb1u, 0xa1a2a4a7u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf1f4f8fcu, 0xe8ebedeeu, 0xd6dbe0e4u); }
        case 19u: { v = vec4<u32>(0xc3c7ccd1u, 0xb3b6babeu, 0xa7aaadb0u, 0x9fa0a3a5u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf4f7fbfdu, 0xe9eceff1u, 0xd8dde1e6u); }
        case 21u: { v = vec4<u32>(0xc3c8cdd2u, 0xb3b6babfu, 0xa7a9acafu, 0x9ea0a2a4u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf7fafcfeu, 0xebeef1f4u, 0xdadfe3e7u); }
        case 23u: { v = vec4<u32>(0xc5cacfd4u, 0xb4b8bcc0u, 0xa7aaadb0u, 0x9ea0a2a4u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xedf0f3f6u, 0xdce1e6eau); }
        case 25u: { v = vec4<u32>(0xc7ccd2d7u, 0xb5b9bec2u, 0xa8abaeb2u, 0x9ea1a3a5u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xfbfcfeffu, 0xf0f3f6f8u, 0xdfe4e8ecu); }
        case 27u: { v = vec4<u32>(0xcad0d5dau, 0xb8bcc1c5u, 0xaaadb0b4u, 0xa0a2a5a7u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf2f5f8fau, 0xe2e7ebefu); }
        case 29u: { v = vec4<u32>(0xced3d8ddu, 0xbbc0c4c9u, 0xadb0b3b7u, 0xa2a4a7aau); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f7f9fbu, 0xe5eaeef1u); }
        case 31u: { v = vec4<u32>(0xd2d7dce1u, 0xbfc3c8cdu, 0xb0b3b7bbu, 0xa4a7aaadu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xe8ecf0f3u); }
        case 33u: { v = vec4<u32>(0xd6dbe0e4u, 0xc3c7ccd1u, 0xb3b7bbbfu, 0xa7aaadb0u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafbfdu, 0xebeff2f5u); }
        case 35u: { v = vec4<u32>(0xdadfe3e7u, 0xc7ccd0d5u, 0xb7bbbfc3u, 0xabadb0b4u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeef1f4f7u); }
        case 37u: { v = vec4<u32>(0xdee2e7ebu, 0xccd0d5d9u, 0xbcbfc3c8u, 0xaeb1b5b8u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf1f4f6f8u); }
        case 39u: { v = vec4<u32>(0xe2e6eaedu, 0xd1d5d9deu, 0xc0c4c8ccu, 0xb2b6b9bcu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f5f8f9u); }
        case 41u: { v = vec4<u32>(0xe6e9edf0u, 0xd5d9dee2u, 0xc5c9cdd1u, 0xb7babec1u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfefeu, 0xf5f7f9fau); }
        case 43u: { v = vec4<u32>(0xe9edf0f2u, 0xdadee2e6u, 0xcaced2d6u, 0xbcbfc3c6u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f8fafbu); }
        case 45u: { v = vec4<u32>(0xeceff2f5u, 0xdfe2e6e9u, 0xcfd3d7dbu, 0xc1c4c8cbu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 47u: { v = vec4<u32>(0xeff2f4f6u, 0xe3e6eaedu, 0xd5d8dcdfu, 0xc6cacdd1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedf0u, 0xdadde1e4u, 0xcccfd3d6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfcfdu); }
        case 51u: { v = vec4<u32>(0xf5f6f8f9u, 0xebeef0f3u, 0xdfe2e5e8u, 0xd2d5d9dcu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 53u: { v = vec4<u32>(0xf7f8fafbu, 0xeff1f3f5u, 0xe4e7eaedu, 0xd8dbdfe2u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfefeu); }
        case 55u: { v = vec4<u32>(0xf9fafbfcu, 0xf3f4f6f7u, 0xeaeceef1u, 0xdfe2e5e7u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 57u: { v = vec4<u32>(0xfafbfcfdu, 0xf6f7f8f9u, 0xeff1f3f4u, 0xe6e8ebedu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 59u: { v = vec4<u32>(0xfcfdfdfdu, 0xf9fafbfbu, 0xf4f5f7f8u, 0xedeff1f2u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 61u: { v = vec4<u32>(0xfdfefefeu, 0xfbfcfdfdu, 0xf9f9fafbu, 0xf4f5f7f8u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xfeffffffu, 0xfefefefeu, 0xfdfdfdfdu, 0xfbfbfcfcu); }
        default: {}
      }
    }
    case 6u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 1u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfdfefefeu, 0xfdfdfdfdu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefdfdfcu, 0xfdfdfdfeu, 0xfbfcfcfdu); }
        case 3u: { v = vec4<u32>(0xf9fafafbu, 0xf7f8f8f9u, 0xf5f6f6f7u, 0xf3f3f4f4u); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfaf9f7f4u, 0xf9fafafau, 0xf5f6f7f8u); }
        case 5u: { v = vec4<u32>(0xf0f1f2f4u, 0xebecedefu, 0xe6e7e8e9u, 0xe0e2e3e4u); }
        case 6u: { v = vec4<u32>(0xe6ecfdffu, 0xf6f4f0ebu, 0xf5f6f7f7u, 0xeef0f2f4u); }
        case 7u: { v = vec4<u32>(0xe6e8eaecu, 0xdee0e2e4u, 0xd7d9dadcu, 0xd0d2d3d5u); }
        case 8u: { v = vec4<u32>(0xeaf7ffffu, 0xf1efebe7u, 0xf1f3f3f3u, 0xe8ebedf0u); }
        case 9u: { v = vec4<u32>(0xdee0e3e6u, 0xd3d6d8dbu, 0xcacdcfd1u, 0xc3c4c6c8u); }
        case 10u: { v = vec4<u32>(0xf2fcffffu, 0xeeebe9eau, 0xeeeff0efu, 0xe4e7eaecu); }
        case 11u: { v = vec4<u32>(0xd7dadde0u, 0xcbcdd0d3u, 0xc1c3c5c8u, 0xb8babcbeu); }
        case 12u: { v = vec4<u32>(0xf8feffffu, 0xebeaebf0u, 0xecedededu, 0xe0e3e7eau); }
        case 13u: { v = vec4<u32>(0xd1d5d8dcu, 0xc4c7caceu, 0xb9bcbec1u, 0xb0b2b4b7u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xebeceff5u, 0xeaecececu, 0xdde1e5e8u); }
        case 15u: { v = vec4<u32>(0xcdd1d5d9u, 0xbfc2c6c9u, 0xb4b6b9bcu, 0xabadafb1u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xedeff4f9u, 0xe9ebececu, 0xdce0e4e7u); }
        case 17u: { v = vec4<u32>(0xcbcfd3d8u, 0xbcbfc3c7u, 0xb0b2b5b8u, 0xa7a9abadu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf0f3f8fcu, 0xeaebedeeu, 0xdce0e4e7u); }
        case 19u: { v = vec4<u32>(0xcaced3d7u, 0xbabdc1c5u, 0xadb0b3b6u, 0xa4a6a8abu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fafdu, 0xeaedeef0u, 0xdde1e5e8u); }
        case 21u: { v = vec4<u32>(0xcaced3d8u, 0xb9bdc1c5u, 0xacafb2b5u, 0xa2a4a7a9u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xeceef1f3u, 0xdee2e6e9u); }
        case 23u: { v = vec4<u32>(0xcbcfd4d9u, 0xb9bdc1c6u, 0xacafb2b5u, 0xa2a4a6a9u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeef0f3f6u, 0xe0e4e8ebu); }
        case 25u: { v = vec4<u32>(0xccd1d6dbu, 0xbabfc3c8u, 0xacb0b3b7u, 0xa2a4a7a9u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f3f5f8u, 0xe2e6eaedu); }
        case 27u: { v = vec4<u32>(0xcfd4d9ddu, 0xbcc1c5cau, 0xaeb1b5b8u, 0xa3a5a8abu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf2f5f7fau, 0xe4e8ecefu); }
        case 29u: { v = vec4<u32>(0xd2d7dbe0u, 0xbfc3c8cdu, 0xb0b3b7bbu, 0xa4a7aaadu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f7f9fbu, 0xe7ebeef1u); }
        case 31u: { v = vec4<u32>(0xd5dadee3u, 0xc2c7cbd0u, 0xb2b6babeu, 0xa6a9acafu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xeaedf1f3u); }
        case 33u: { v = vec4<u32>(0xd8dde2e6u, 0xc6cacfd4u, 0xb6b9bdc1u, 0xa9acafb2u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafbfdu, 0xecf0f3f5u); }
        case 35u: { v = vec4<u32>(0xdce0e5e9u, 0xcaced3d7u, 0xb9bdc1c5u, 0xacafb2b6u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeff2f5f7u); }
        case 37u: { v = vec4<u32>(0xe0e4e8ebu, 0xced2d7dbu, 0xbdc1c5c9u, 0xb0b3b6b9u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf1f4f6f8u); }
        case 39u: { v = vec4<u32>(0xe3e7ebeeu, 0xd2d6dbdfu, 0xc1c5c9ceu, 0xb3b7babeu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f6f8fau); }
        case 41u: { v = vec4<u32>(0xe7eaedf1u, 0xd6dbdfe3u, 0xc6caced2u, 0xb8bbbec2u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfefeu, 0xf5f7f9fbu); }
        case 43u: { v = vec4<u32>(0xeaedf0f3u, 0xdbdfe3e6u, 0xcbcfd3d7u, 0xbcc0c3c7u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f9fafbu); }
        case 45u: { v = vec4<u32>(0xedf0f2f5u, 0xdfe3e6eau, 0xd0d4d7dbu, 0xc1c5c8ccu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 47u: { v = vec4<u32>(0xf0f2f4f6u, 0xe3e7eaedu, 0xd5d8dce0u, 0xc6cacdd1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xfafbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedf0u, 0xdadde1e4u, 0xcccfd3d6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfcfdu); }
        case 51u: { v = vec4<u32>(0xf5f6f8f9u, 0xebeef0f3u, 0xdfe2e5e8u, 0xd2d5d8dcu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 53u: { v = vec4<u32>(0xf7f8f9fbu, 0xeff1f3f5u, 0xe4e7eaecu, 0xd8dbdee1u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfefeu); }
        case 55u: { v = vec4<u32>(0xf9fafbfcu, 0xf2f4f6f7u, 0xe9eceef0u, 0xdee1e4e7u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 57u: { v = vec4<u32>(0xfafbfcfdu, 0xf5f7f8f9u, 0xeef0f2f4u, 0xe5e7eaecu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefefeu); }
        case 59u: { v = vec4<u32>(0xfcfcfdfdu, 0xf8f9fafbu, 0xf3f5f6f7u, 0xeceef0f1u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefeffffu); }
        case 61u: { v = vec4<u32>(0xfdfdfefeu, 0xfbfcfcfdu, 0xf8f9fafau, 0xf3f4f6f7u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xfefefeffu, 0xfdfdfefeu, 0xfcfcfcfdu, 0xf9fafbfbu); }
        default: {}
      }
    }
    case 7u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xfefefeffu, 0xfefefefeu, 0xfefefefeu, 0xfdfdfefeu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefdfdfcu, 0xfdfefefeu, 0xfcfcfdfdu); }
        case 3u: { v = vec4<u32>(0xfbfbfbfcu, 0xf9f9fafau, 0xf7f7f8f8u, 0xf5f5f6f6u); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfaf9f7f4u, 0xfafbfbfbu, 0xf7f8f9fau); }
        case 5u: { v = vec4<u32>(0xf3f4f5f6u, 0xeeeff1f2u, 0xeaebecedu, 0xe5e6e8e9u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf6f4f0ebu, 0xf7f7f8f7u, 0xf1f3f4f6u); }
        case 7u: { v = vec4<u32>(0xebeceef0u, 0xe3e5e7e9u, 0xdddee0e2u, 0xd6d8d9dbu); }
        case 8u: { v = vec4<u32>(0xe9f7ffffu, 0xf1eeeae7u, 0xf3f4f4f3u, 0xeceef0f2u); }
        case 9u: { v = vec4<u32>(0xe3e5e8eau, 0xdadcdee1u, 0xd1d3d5d7u, 0xc9cbcdcfu); }
        case 10u: { v = vec4<u32>(0xf2fcffffu, 0xedeae8e9u, 0xf0f1f1f0u, 0xe8ebedefu); }
        case 11u: { v = vec4<u32>(0xdddfe2e5u, 0xd1d4d7dau, 0xc8cacccfu, 0xbfc1c3c5u); }
        case 12u: { v = vec4<u32>(0xf8feffffu, 0xebe9eaefu, 0xeeeeeeedu, 0xe5e8eaecu); }
        case 13u: { v = vec4<u32>(0xd7dbdee1u, 0xcbced1d4u, 0xc0c2c5c8u, 0xb7b9bbbeu); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xebebeef5u, 0xecedecebu, 0xe2e5e8eau); }
        case 15u: { v = vec4<u32>(0xd4d7dbdfu, 0xc6c9ccd0u, 0xbabdc0c3u, 0xb1b3b5b8u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeceff3f9u, 0xebecececu, 0xe1e4e7e9u); }
        case 17u: { v = vec4<u32>(0xd1d5d9ddu, 0xc2c6c9cdu, 0xb6b9bcbfu, 0xacaeb1b3u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xeff3f7fbu, 0xebececedu, 0xe0e4e7e9u); }
        case 19u: { v = vec4<u32>(0xd0d4d8dcu, 0xc0c3c7cbu, 0xb3b6b9bcu, 0xa9abaeb0u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf2f6fafdu, 0xebedeef0u, 0xe0e4e7e9u); }
        case 21u: { v = vec4<u32>(0xcfd4d8dcu, 0xbfc2c6cbu, 0xb1b4b7bbu, 0xa7a9acaeu); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xeceef0f3u, 0xe1e5e8eau); }
        case 23u: { v = vec4<u32>(0xd0d4d9ddu, 0xbec2c7cbu, 0xb0b3b7bau, 0xa6a8abadu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeef0f3f5u, 0xe2e6e9ecu); }
        case 25u: { v = vec4<u32>(0xd1d5dadeu, 0xbfc3c8ccu, 0xb0b4b7bbu, 0xa5a8aaadu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f8u, 0xe4e8ebeeu); }
        case 27u: { v = vec4<u32>(0xd3d7dce0u, 0xc0c5c9ceu, 0xb1b5b8bcu, 0xa6a8abaeu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f5f7f9u, 0xe6eaedf0u); }
        case 29u: { v = vec4<u32>(0xd5dadee2u, 0xc3c7ccd0u, 0xb3b7babeu, 0xa7aaacb0u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f7f9fbu, 0xe8eceff2u); }
        case 31u: { v = vec4<u32>(0xd8dce1e5u, 0xc5caced3u, 0xb5b9bdc1u, 0xa9abaeb2u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xebeef1f4u); }
        case 33u: { v = vec4<u32>(0xdbdfe3e7u, 0xc8cdd1d6u, 0xb8bcc0c4u, 0xabaeb1b4u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafbfdu, 0xedf0f3f5u); }
        case 35u: { v = vec4<u32>(0xdee2e6eau, 0xccd0d5d9u, 0xbbbfc3c7u, 0xadb1b4b7u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeff2f5f7u); }
        case 37u: { v = vec4<u32>(0xe1e5e9ecu, 0xd0d4d8ddu, 0xbfc3c7cbu, 0xb1b4b7bbu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf1f4f6f8u); }
        case 39u: { v = vec4<u32>(0xe4e8ebefu, 0xd3d8dce0u, 0xc3c7cbcfu, 0xb4b8bbbfu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f6f8fau); }
        case 41u: { v = vec4<u32>(0xe7ebeef1u, 0xd7dce0e4u, 0xc7cbcfd3u, 0xb8bcbfc3u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfefeu, 0xf5f7f9fbu); }
        case 43u: { v = vec4<u32>(0xeaedf0f3u, 0xdcdfe3e7u, 0xcbcfd3d8u, 0xbcc0c4c7u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f9fafbu); }
        case 45u: { v = vec4<u32>(0xedf0f3f5u, 0xe0e3e7eau, 0xd0d4d8dcu, 0xc1c5c8ccu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 47u: { v = vec4<u32>(0xf0f2f5f7u, 0xe4e7eaedu, 0xd5d9dce0u, 0xc6cacdd1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedf0u, 0xdadde1e4u, 0xcbcfd3d6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfcfdu); }
        case 51u: { v = vec4<u32>(0xf5f6f8f9u, 0xebeef0f2u, 0xdfe2e5e8u, 0xd1d5d8dbu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 53u: { v = vec4<u32>(0xf7f8f9fbu, 0xeff1f3f5u, 0xe4e7eaecu, 0xd7dadee1u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 55u: { v = vec4<u32>(0xf8fafbfcu, 0xf2f4f6f7u, 0xe9ebeef0u, 0xdde0e3e6u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 57u: { v = vec4<u32>(0xfafbfcfcu, 0xf5f7f8f9u, 0xeef0f2f3u, 0xe4e6e9ebu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefefeu); }
        case 59u: { v = vec4<u32>(0xfcfcfdfdu, 0xf8f9fafbu, 0xf2f4f5f7u, 0xebedeff1u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefeffffu); }
        case 61u: { v = vec4<u32>(0xfdfdfefeu, 0xfafbfcfcu, 0xf7f8f9fau, 0xf1f3f4f6u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xfefefefeu, 0xfdfdfdfeu, 0xfafbfcfcu, 0xf7f8f9fau); }
        default: {}
      }
    }
    case 8u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xfeffffffu, 0xfefefefeu, 0xfefefefeu, 0xfefefefeu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefdfdfcu, 0xfefefefeu, 0xfdfdfdfdu); }
        case 3u: { v = vec4<u32>(0xfbfcfcfcu, 0xfafafbfbu, 0xf8f9f9f9u, 0xf7f7f7f8u); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbf9f7f4u, 0xfbfbfbfbu, 0xf8f9fafau); }
        case 5u: { v = vec4<u32>(0xf5f6f7f8u, 0xf1f2f3f4u, 0xedeeeff0u, 0xe9eaebecu); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf6f4f0eau, 0xf8f8f8f8u, 0xf4f5f6f7u); }
        case 7u: { v = vec4<u32>(0xeeeff1f2u, 0xe7e9ebecu, 0xe1e3e4e6u, 0xdbdddee0u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf2eeeae6u, 0xf5f5f5f4u, 0xeff1f2f4u); }
        case 9u: { v = vec4<u32>(0xe7e9ebedu, 0xdfe1e3e5u, 0xd7d8dadcu, 0xcfd1d3d5u); }
        case 10u: { v = vec4<u32>(0xf1fcffffu, 0xedeae8e9u, 0xf2f2f1f0u, 0xebedeff1u); }
        case 11u: { v = vec4<u32>(0xe1e4e6e9u, 0xd7d9dcdfu, 0xcdd0d2d4u, 0xc5c7c9cbu); }
        case 12u: { v = vec4<u32>(0xf8fdffffu, 0xebe9eaefu, 0xefefeeedu, 0xe8eaedeeu); }
        case 13u: { v = vec4<u32>(0xdcdfe2e5u, 0xd0d3d6d9u, 0xc6c8cbceu, 0xbdbfc1c3u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xeaebeef5u, 0xededecebu, 0xe6e8eaecu); }
        case 15u: { v = vec4<u32>(0xd9dcdfe3u, 0xcbcfd2d5u, 0xc0c3c5c8u, 0xb6b8bbbdu); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeceef3f9u, 0xecececebu, 0xe4e7e9ebu); }
        case 17u: { v = vec4<u32>(0xd6dadde1u, 0xc8cbcfd2u, 0xbbbec1c4u, 0xb1b3b6b8u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xeff2f7fbu, 0xebececedu, 0xe3e6e8eau); }
        case 19u: { v = vec4<u32>(0xd4d8dce0u, 0xc5c9ccd0u, 0xb8bbbec1u, 0xadb0b2b5u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf2f6fafdu, 0xebeceeefu, 0xe3e6e8eau); }
        case 21u: { v = vec4<u32>(0xd4d8dcdfu, 0xc3c7cbcfu, 0xb6b9bcc0u, 0xabadb0b3u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf5f8fcfeu, 0xeceef0f2u, 0xe3e6e9ebu); }
        case 23u: { v = vec4<u32>(0xd4d8dce0u, 0xc3c7cbcfu, 0xb5b8bbbfu, 0xa9acafb1u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf8fafdfeu, 0xeef0f2f5u, 0xe4e7eaecu); }
        case 25u: { v = vec4<u32>(0xd4d9dde1u, 0xc3c7ccd0u, 0xb4b8bbbfu, 0xa8abaeb1u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xfafcfdfeu, 0xf0f2f5f7u, 0xe6e9ebeeu); }
        case 27u: { v = vec4<u32>(0xd6dadee2u, 0xc4c8cdd1u, 0xb5b8bcc0u, 0xa9abaeb1u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xe7eaedf0u); }
        case 29u: { v = vec4<u32>(0xd8dce0e4u, 0xc6cacfd3u, 0xb6babdc2u, 0xa9acafb2u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf4f6f9fbu, 0xe9eceff2u); }
        case 31u: { v = vec4<u32>(0xdadee2e6u, 0xc8ccd1d6u, 0xb8bbbfc4u, 0xabaeb1b4u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf6f8fafcu, 0xebeef1f4u); }
        case 33u: { v = vec4<u32>(0xdde1e5e8u, 0xcbcfd4d8u, 0xbabec2c6u, 0xacb0b3b6u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfcu, 0xeef0f3f5u); }
        case 35u: { v = vec4<u32>(0xdfe3e7eau, 0xced2d7dbu, 0xbdc1c5c9u, 0xafb2b5b9u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xf0f2f5f7u); }
        case 37u: { v = vec4<u32>(0xe2e6eaedu, 0xd1d6dadeu, 0xc0c4c8cdu, 0xb2b5b9bcu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xf2f4f6f8u); }
        case 39u: { v = vec4<u32>(0xe5e9ecefu, 0xd5d9dde1u, 0xc4c8ccd0u, 0xb5b8bcc0u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8fau); }
        case 41u: { v = vec4<u32>(0xe8ebeef1u, 0xd8dde0e4u, 0xc8ccd0d4u, 0xb9bcc0c4u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfefeu, 0xf5f7f9fbu); }
        case 43u: { v = vec4<u32>(0xebeef1f3u, 0xdce0e4e7u, 0xccd0d4d8u, 0xbdc0c4c8u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f9fafbu); }
        case 45u: { v = vec4<u32>(0xedf0f3f5u, 0xe0e4e7eau, 0xd0d4d8dcu, 0xc1c5c9ccu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 47u: { v = vec4<u32>(0xf0f2f5f7u, 0xe4e7eaedu, 0xd5d9dde0u, 0xc6cacdd1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedf0u, 0xdadde1e4u, 0xcbcfd2d6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafcfcfdu); }
        case 51u: { v = vec4<u32>(0xf4f6f8f9u, 0xebeef0f2u, 0xdee2e5e8u, 0xd0d4d8dbu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfeu); }
        case 53u: { v = vec4<u32>(0xf6f8f9fau, 0xeef1f3f5u, 0xe3e6e9ecu, 0xd6dadde0u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 55u: { v = vec4<u32>(0xf8f9fbfbu, 0xf2f3f5f7u, 0xe8ebedefu, 0xdcdfe2e5u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 57u: { v = vec4<u32>(0xfafbfcfcu, 0xf5f6f7f9u, 0xedeff1f3u, 0xe2e5e8eau); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefefeu); }
        case 59u: { v = vec4<u32>(0xfbfcfdfdu, 0xf7f8fafau, 0xf1f3f5f6u, 0xe9ebedefu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 61u: { v = vec4<u32>(0xfdfdfdfeu, 0xfafbfbfcu, 0xf6f7f8f9u, 0xf0f1f3f4u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 63u: { v = vec4<u32>(0xfdfefefeu, 0xfcfcfdfdu, 0xf9fafbfbu, 0xf5f6f7f8u); }
        default: {}
      }
    }
    case 9u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xfefefeffu, 0xfefefefeu, 0xfefefefeu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefdfdfcu, 0xfefefefeu, 0xfdfdfdfeu); }
        case 3u: { v = vec4<u32>(0xfcfcfcfdu, 0xfbfbfbfcu, 0xf9fafafau, 0xf8f8f9f9u); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf7f4u, 0xfbfcfcfbu, 0xf9fafbfbu); }
        case 5u: { v = vec4<u32>(0xf6f7f8f9u, 0xf3f4f5f6u, 0xeff0f1f2u, 0xecedeeeeu); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf6f4f0eau, 0xf8f9f8f8u, 0xf5f6f7f8u); }
        case 7u: { v = vec4<u32>(0xf0f2f3f4u, 0xeaecedefu, 0xe5e6e8e9u, 0xdfe1e2e3u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf1eeeae6u, 0xf5f5f5f4u, 0xf1f3f4f5u); }
        case 9u: { v = vec4<u32>(0xeaeceef0u, 0xe2e4e6e8u, 0xdbdddfe0u, 0xd4d6d7d9u); }
        case 10u: { v = vec4<u32>(0xf1fcffffu, 0xedeae7e9u, 0xf2f2f2f0u, 0xeeeff1f2u); }
        case 11u: { v = vec4<u32>(0xe5e7e9ecu, 0xdbdee0e2u, 0xd2d4d7d9u, 0xcaccced0u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae9e9efu, 0xf0f0efedu, 0xebedeeefu); }
        case 13u: { v = vec4<u32>(0xe0e3e6e8u, 0xd5d8dbddu, 0xcbcdd0d2u, 0xc2c4c6c8u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xeaeaeef4u, 0xeeedecebu, 0xe8eaecedu); }
        case 15u: { v = vec4<u32>(0xdde0e3e6u, 0xd0d3d6dau, 0xc5c7cacdu, 0xbbbdc0c2u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xebeef2f8u, 0xececebebu, 0xe7e9ebecu); }
        case 17u: { v = vec4<u32>(0xdadde1e4u, 0xccd0d3d7u, 0xc0c3c6c9u, 0xb6b8bbbdu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xeef2f6fbu, 0xececececu, 0xe5e8eaebu); }
        case 19u: { v = vec4<u32>(0xd8dcdfe3u, 0xc9cdd1d4u, 0xbcbfc3c6u, 0xb1b4b7b9u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf1f5f9fdu, 0xececedefu, 0xe5e7e9ebu); }
        case 21u: { v = vec4<u32>(0xd7dbdfe2u, 0xc8cccfd3u, 0xbabdc0c4u, 0xafb1b4b7u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf5f8fbfdu, 0xeceeeff1u, 0xe5e8eaebu); }
        case 23u: { v = vec4<u32>(0xd7dbdfe2u, 0xc7cbcfd3u, 0xb8bcbfc3u, 0xadafb2b5u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xeef0f2f4u, 0xe6e8ebecu); }
        case 25u: { v = vec4<u32>(0xd7dcdfe3u, 0xc7cbcfd3u, 0xb8bbbfc3u, 0xabaeb1b4u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xf0f2f4f7u, 0xe7eaeceeu); }
        case 27u: { v = vec4<u32>(0xd9dde0e4u, 0xc7ccd0d4u, 0xb8bbbfc3u, 0xabaeb1b4u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f6f9u, 0xe8ebedf0u); }
        case 29u: { v = vec4<u32>(0xdadee2e5u, 0xc9cdd1d6u, 0xb9bcc0c4u, 0xabaeb2b5u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf4f6f8fau, 0xeaedeff2u); }
        case 31u: { v = vec4<u32>(0xdce0e4e7u, 0xcbcfd3d8u, 0xbabec2c6u, 0xacb0b3b6u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf6f8fafcu, 0xeceff1f3u); }
        case 33u: { v = vec4<u32>(0xdee2e6e9u, 0xcdd1d6dau, 0xbcc0c4c8u, 0xaeb1b5b8u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeef1f3f5u); }
        case 35u: { v = vec4<u32>(0xe1e4e8ebu, 0xd0d4d8ddu, 0xbfc3c7cbu, 0xb0b3b7bbu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fafcfdu, 0xf0f2f5f7u); }
        case 37u: { v = vec4<u32>(0xe3e7eaedu, 0xd3d7dbdfu, 0xc1c6caceu, 0xb3b6babdu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfdu, 0xf2f4f6f8u); }
        case 39u: { v = vec4<u32>(0xe6e9ecefu, 0xd6dadee2u, 0xc5c9cdd2u, 0xb5b9bdc1u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8f9u); }
        case 41u: { v = vec4<u32>(0xe8eceff1u, 0xd9dde1e5u, 0xc8cdd1d5u, 0xb9bdc0c4u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu, 0xf5f7f9fau); }
        case 43u: { v = vec4<u32>(0xebeef1f3u, 0xdde1e4e8u, 0xccd1d5d9u, 0xbdc0c4c8u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f9fafbu); }
        case 45u: { v = vec4<u32>(0xedf0f3f5u, 0xe0e4e7ebu, 0xd1d5d9dcu, 0xc1c5c9cdu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 47u: { v = vec4<u32>(0xf0f2f5f6u, 0xe4e7eaedu, 0xd5d9dde0u, 0xc5c9cdd1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedf0u, 0xd9dde1e4u, 0xcaced2d6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 51u: { v = vec4<u32>(0xf4f6f8f9u, 0xebedf0f2u, 0xdee1e5e8u, 0xcfd3d7dau); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 53u: { v = vec4<u32>(0xf6f8f9fau, 0xeef0f2f4u, 0xe3e6e9ebu, 0xd5d9dcdfu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 55u: { v = vec4<u32>(0xf8f9fafbu, 0xf1f3f5f6u, 0xe7eaecefu, 0xdbdee1e4u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 57u: { v = vec4<u32>(0xf9fbfbfcu, 0xf4f6f7f8u, 0xeceef0f2u, 0xe1e4e7e9u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfdfefefeu); }
        case 59u: { v = vec4<u32>(0xfbfcfcfdu, 0xf7f8f9fau, 0xf0f2f4f5u, 0xe7eaeceeu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 61u: { v = vec4<u32>(0xfcfdfdfeu, 0xf9fafbfcu, 0xf4f6f7f8u, 0xedeff1f3u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefeffffu); }
        case 63u: { v = vec4<u32>(0xfdfdfefeu, 0xfbfcfcfdu, 0xf8f9f9fau, 0xf3f4f5f7u); }
        default: {}
      }
    }
    case 10u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xfefefefeu, 0xfefefefeu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfdfdfefeu); }
        case 3u: { v = vec4<u32>(0xfcfdfdfdu, 0xfbfcfcfcu, 0xfafafbfbu, 0xf9f9f9fau); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf7f4u, 0xfcfcfcfbu, 0xfafbfbfbu); }
        case 5u: { v = vec4<u32>(0xf7f8f9fau, 0xf4f5f6f7u, 0xf1f2f3f4u, 0xeeeff0f0u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf6f4f0eau, 0xf9f9f9f8u, 0xf6f7f8f9u); }
        case 7u: { v = vec4<u32>(0xf2f3f4f5u, 0xedeeeff1u, 0xe8e9eaecu, 0xe2e4e5e6u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf1eeeae6u, 0xf6f6f5f4u, 0xf3f4f5f6u); }
        case 9u: { v = vec4<u32>(0xedeef0f1u, 0xe6e7e9ebu, 0xdee0e2e4u, 0xd8d9dbddu); }
        case 10u: { v = vec4<u32>(0xf1fcffffu, 0xedeae7e8u, 0xf3f3f2f0u, 0xeff1f2f3u); }
        case 11u: { v = vec4<u32>(0xe8eaeceeu, 0xdfe1e3e5u, 0xd6d8daddu, 0xced0d2d4u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e9eeu, 0xf0f0efedu, 0xedeef0f0u); }
        case 13u: { v = vec4<u32>(0xe3e6e8ebu, 0xd9dcdee1u, 0xcfd1d4d6u, 0xc6c8cacdu); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe9eaedf4u, 0xeeeeecebu, 0xeaecedeeu); }
        case 15u: { v = vec4<u32>(0xe0e3e6e8u, 0xd4d7daddu, 0xc9ccced1u, 0xbfc1c4c6u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xebedf2f8u, 0xedecebebu, 0xe8eaececu); }
        case 17u: { v = vec4<u32>(0xdde0e3e6u, 0xd0d4d7dau, 0xc4c7cacdu, 0xbabcbfc1u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xeef1f6fbu, 0xececebecu, 0xe7e9ebebu); }
        case 19u: { v = vec4<u32>(0xdbdfe2e5u, 0xcdd1d4d8u, 0xc0c3c7cau, 0xb5b8bbbdu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf1f5f9fcu, 0xececedeeu, 0xe7e9eaebu); }
        case 21u: { v = vec4<u32>(0xdadee1e4u, 0xcbcfd3d7u, 0xbec1c4c8u, 0xb2b5b8bau); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf4f8fbfdu, 0xecedeff1u, 0xe7e9eaebu); }
        case 23u: { v = vec4<u32>(0xdadde1e4u, 0xcaced2d6u, 0xbcbfc3c6u, 0xb0b2b5b9u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf7fafcfeu, 0xeeeff1f4u, 0xe7e9ebecu); }
        case 25u: { v = vec4<u32>(0xdadee1e4u, 0xcaced2d6u, 0xbbbec2c6u, 0xaeb1b4b7u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xf0f1f4f6u, 0xe8eaeceeu); }
        case 27u: { v = vec4<u32>(0xdbdfe2e5u, 0xcaced3d7u, 0xbbbec2c6u, 0xadb0b4b7u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f6f8u, 0xe9ebeef0u); }
        case 29u: { v = vec4<u32>(0xdce0e3e6u, 0xcbd0d4d8u, 0xbbbfc3c7u, 0xadb1b4b7u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf4f6f8fau, 0xebedeff1u); }
        case 31u: { v = vec4<u32>(0xdee1e5e8u, 0xcdd1d5dau, 0xbcc0c4c8u, 0xaeb1b5b8u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f8fafbu, 0xeceff1f3u); }
        case 33u: { v = vec4<u32>(0xdfe3e7eau, 0xcfd3d7dcu, 0xbec2c6cau, 0xafb3b6bau); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeef1f3f5u); }
        case 35u: { v = vec4<u32>(0xe2e5e8ebu, 0xd1d5dadeu, 0xc0c4c8cdu, 0xb1b5b8bcu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fafcfdu, 0xf0f2f5f7u); }
        case 37u: { v = vec4<u32>(0xe4e7ebedu, 0xd4d8dce0u, 0xc3c7cbcfu, 0xb3b7bbbfu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfcfdu, 0xf2f4f6f8u); }
        case 39u: { v = vec4<u32>(0xe6eaedefu, 0xd7dbdfe3u, 0xc6caced2u, 0xb6babec2u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8f9u); }
        case 41u: { v = vec4<u32>(0xe9eceff1u, 0xdadee2e5u, 0xc9cdd2d6u, 0xb9bdc1c5u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu, 0xf5f7f9fau); }
        case 43u: { v = vec4<u32>(0xebeef1f3u, 0xdde1e5e8u, 0xcdd1d5d9u, 0xbdc0c4c9u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f8fafbu); }
        case 45u: { v = vec4<u32>(0xeef0f3f5u, 0xe0e4e7ebu, 0xd1d5d9ddu, 0xc1c4c8cdu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf8fafbfcu); }
        case 47u: { v = vec4<u32>(0xf0f2f4f6u, 0xe4e7eaedu, 0xd5d9dce0u, 0xc5c9cdd1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedf0u, 0xd9dde0e4u, 0xc9cdd1d5u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 51u: { v = vec4<u32>(0xf4f6f8f9u, 0xeaedf0f2u, 0xdde1e4e7u, 0xced2d6dau); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 53u: { v = vec4<u32>(0xf6f7f9fau, 0xedf0f2f4u, 0xe2e5e8ebu, 0xd4d7dbdeu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 55u: { v = vec4<u32>(0xf8f9fafbu, 0xf0f2f4f6u, 0xe6e9eceeu, 0xd9dde0e3u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 57u: { v = vec4<u32>(0xf9fafbfcu, 0xf3f5f6f8u, 0xeaedeff1u, 0xdfe2e5e8u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 59u: { v = vec4<u32>(0xfbfbfcfdu, 0xf6f7f8fau, 0xeff1f3f4u, 0xe5e8eaedu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefefeu); }
        case 61u: { v = vec4<u32>(0xfcfcfdfdu, 0xf8f9fafbu, 0xf3f4f6f7u, 0xebedeff1u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 63u: { v = vec4<u32>(0xfdfdfdfeu, 0xfafbfbfcu, 0xf6f7f8f9u, 0xf0f2f3f5u); }
        default: {}
      }
    }
    case 11u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefefeu, 0xfefefefeu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfdfdfdfdu, 0xfcfcfcfcu, 0xfbfbfbfbu, 0xf9fafafau); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf7f3u, 0xfcfcfcfcu, 0xfbfbfcfcu); }
        case 5u: { v = vec4<u32>(0xf8f9fafau, 0xf6f6f7f8u, 0xf3f3f4f5u, 0xf0f1f1f2u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf6f4f0eau, 0xf9f9f9f8u, 0xf7f8f9f9u); }
        case 7u: { v = vec4<u32>(0xf3f5f6f7u, 0xeff0f1f2u, 0xeaebeceeu, 0xe5e6e8e9u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf1eee9e6u, 0xf6f6f5f4u, 0xf4f5f6f6u); }
        case 9u: { v = vec4<u32>(0xeff0f2f3u, 0xe8eaebedu, 0xe1e3e5e6u, 0xdbdddee0u); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e7e8u, 0xf4f3f2f0u, 0xf1f2f3f4u); }
        case 11u: { v = vec4<u32>(0xeaeceeefu, 0xe2e4e6e8u, 0xd9dcdee0u, 0xd2d4d6d7u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e9eeu, 0xf1f0efecu, 0xeeeff0f1u); }
        case 13u: { v = vec4<u32>(0xe6e8eaecu, 0xdcdfe1e4u, 0xd3d5d7dau, 0xcaccced0u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe9e9edf4u, 0xefeeeceau, 0xecedeeefu); }
        case 15u: { v = vec4<u32>(0xe3e5e8eau, 0xd7dadde0u, 0xcdcfd2d5u, 0xc3c5c8cau); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaedf2f8u, 0xedecebeau, 0xeaecededu); }
        case 17u: { v = vec4<u32>(0xe0e3e6e8u, 0xd4d7daddu, 0xc8cbced1u, 0xbdc0c2c5u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xedf1f6fbu, 0xecebebebu, 0xe9eaebecu); }
        case 19u: { v = vec4<u32>(0xdee1e4e7u, 0xd1d4d7dbu, 0xc4c7cacdu, 0xb9bbbec1u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf1f5f9fcu, 0xecececeeu, 0xe8eaebebu); }
        case 21u: { v = vec4<u32>(0xdde0e3e6u, 0xcfd2d6d9u, 0xc1c4c8cbu, 0xb5b8bbbeu); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf4f8fbfdu, 0xecedeef1u, 0xe8e9ebecu); }
        case 23u: { v = vec4<u32>(0xdce0e3e5u, 0xcdd1d5d9u, 0xbfc2c6cau, 0xb2b5b8bcu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf7fafcfeu, 0xeeeff1f4u, 0xe8eaebecu); }
        case 25u: { v = vec4<u32>(0xdce0e3e6u, 0xcdd1d5d8u, 0xbec1c5c9u, 0xb1b4b7bau); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeff1f3f6u, 0xe9eaeceeu); }
        case 27u: { v = vec4<u32>(0xdde0e3e6u, 0xcdd1d5d9u, 0xbdc1c5c9u, 0xb0b3b6bau); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf1f3f6f8u, 0xeaeceeefu); }
        case 29u: { v = vec4<u32>(0xdee1e4e7u, 0xcdd2d6dau, 0xbdc1c5c9u, 0xafb3b6bau); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf3f5f8fau, 0xebedeff1u); }
        case 31u: { v = vec4<u32>(0xdfe2e6e8u, 0xcfd3d7dbu, 0xbec2c6cau, 0xb0b3b7bau); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f7f9fbu, 0xedeff1f3u); }
        case 33u: { v = vec4<u32>(0xe1e4e7eau, 0xd0d5d9ddu, 0xbfc4c8ccu, 0xb0b4b8bbu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeef1f3f5u); }
        case 35u: { v = vec4<u32>(0xe2e6e9ecu, 0xd2d7dbdfu, 0xc1c6caceu, 0xb2b6b9bdu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xf0f2f5f7u); }
        case 37u: { v = vec4<u32>(0xe5e8ebeeu, 0xd5d9dde1u, 0xc4c8ccd1u, 0xb4b8bbbfu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfcfdu, 0xf2f4f6f8u); }
        case 39u: { v = vec4<u32>(0xe7eaedefu, 0xd8dce0e3u, 0xc6cbcfd3u, 0xb6babec2u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8f9u); }
        case 41u: { v = vec4<u32>(0xe9eceff1u, 0xdadee2e6u, 0xc9ced2d6u, 0xb9bdc1c5u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu, 0xf5f7f9fau); }
        case 43u: { v = vec4<u32>(0xebeef1f3u, 0xdde1e5e8u, 0xcdd1d5d9u, 0xbcc0c4c9u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f8fafbu); }
        case 45u: { v = vec4<u32>(0xeef0f3f5u, 0xe0e4e7ebu, 0xd0d5d9ddu, 0xc0c4c8ccu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf8f9fbfcu); }
        case 47u: { v = vec4<u32>(0xf0f2f4f6u, 0xe4e7eaedu, 0xd4d8dce0u, 0xc4c8ccd0u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fafcfcu); }
        case 49u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedefu, 0xd8dce0e3u, 0xc8ccd0d4u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 51u: { v = vec4<u32>(0xf4f6f7f9u, 0xeaedeff2u, 0xdce0e4e7u, 0xcdd1d5d9u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfdfdu); }
        case 53u: { v = vec4<u32>(0xf6f7f9fau, 0xedeff2f4u, 0xe1e4e7eau, 0xd2d6daddu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 55u: { v = vec4<u32>(0xf7f9fafbu, 0xf0f2f4f6u, 0xe5e8ebedu, 0xd7dbdee2u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfcfdfefeu); }
        case 57u: { v = vec4<u32>(0xf9fafbfcu, 0xf2f4f6f7u, 0xe9eceef0u, 0xdde0e3e6u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 59u: { v = vec4<u32>(0xfafbfcfcu, 0xf5f6f8f9u, 0xedeff1f3u, 0xe3e6e8ebu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefefeu); }
        case 61u: { v = vec4<u32>(0xfbfcfdfdu, 0xf7f8f9fau, 0xf1f3f4f6u, 0xe9ebedefu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 63u: { v = vec4<u32>(0xfcfdfdfeu, 0xf9fafbfbu, 0xf4f6f7f8u, 0xedeff1f3u); }
        default: {}
      }
    }
    case 12u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfefefefeu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfdfdfdfeu, 0xfcfcfdfdu, 0xfbfbfcfcu, 0xfafafbfbu); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf7f3u, 0xfcfcfcfcu, 0xfbfcfcfcu); }
        case 5u: { v = vec4<u32>(0xf9fafafbu, 0xf7f7f8f9u, 0xf4f5f5f6u, 0xf1f2f3f3u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf6f4f0eau, 0xfafaf9f8u, 0xf8f9f9fau); }
        case 7u: { v = vec4<u32>(0xf5f6f7f7u, 0xf0f1f3f4u, 0xecedeeefu, 0xe7e8eaebu); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf1eee9e6u, 0xf7f6f6f4u, 0xf5f6f6f7u); }
        case 9u: { v = vec4<u32>(0xf0f1f3f4u, 0xeaecedefu, 0xe4e5e7e9u, 0xdedfe1e2u); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e7e8u, 0xf4f3f2f0u, 0xf2f3f4f4u); }
        case 11u: { v = vec4<u32>(0xeceeeff1u, 0xe4e6e8eau, 0xdcdee0e2u, 0xd5d7d8dau); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e8eeu, 0xf1f0efecu, 0xeff0f1f1u); }
        case 13u: { v = vec4<u32>(0xe8eaeceeu, 0xdfe1e4e6u, 0xd6d8daddu, 0xcdcfd1d3u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe9e9edf4u, 0xefeeeceau, 0xedeeefefu); }
        case 15u: { v = vec4<u32>(0xe5e7e9ebu, 0xdadde0e2u, 0xd0d2d5d8u, 0xc6c8cbcdu); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaedf2f8u, 0xedecebeau, 0xebecededu); }
        case 17u: { v = vec4<u32>(0xe2e5e7e9u, 0xd7dadddfu, 0xcbced1d4u, 0xc0c3c5c8u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xedf1f6fbu, 0xecebebebu, 0xeaebececu); }
        case 19u: { v = vec4<u32>(0xe0e3e6e8u, 0xd4d7daddu, 0xc7cacdd0u, 0xbcbec1c4u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xecececedu, 0xe9eaebebu); }
        case 21u: { v = vec4<u32>(0xdfe2e5e7u, 0xd1d5d8dcu, 0xc4c7caceu, 0xb8bbbec1u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf4f7fbfdu, 0xecedeef0u, 0xe8eaebecu); }
        case 23u: { v = vec4<u32>(0xdee1e4e6u, 0xd0d4d7dbu, 0xc2c5c9ccu, 0xb5b8bbbeu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6fafcfeu, 0xedeff1f3u, 0xe8eaebecu); }
        case 25u: { v = vec4<u32>(0xdee1e4e6u, 0xcfd3d7dau, 0xc0c4c7cbu, 0xb3b6b9bdu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeff1f3f6u, 0xe9ebeceeu); }
        case 27u: { v = vec4<u32>(0xdee1e4e7u, 0xcfd3d7dbu, 0xbfc3c7cbu, 0xb2b5b8bcu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xf1f3f5f8u, 0xeaeceeefu); }
        case 29u: { v = vec4<u32>(0xdfe2e5e8u, 0xcfd3d7dbu, 0xbfc3c7cbu, 0xb1b4b8bbu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf3f5f7fau, 0xebedeff1u); }
        case 31u: { v = vec4<u32>(0xe0e3e6e9u, 0xd0d4d9dcu, 0xc0c4c8ccu, 0xb1b4b8bcu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f7f9fbu, 0xedeff1f3u); }
        case 33u: { v = vec4<u32>(0xe1e5e8eau, 0xd2d6dadeu, 0xc1c5c9cdu, 0xb2b5b9bdu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeef1f3f5u); }
        case 35u: { v = vec4<u32>(0xe3e6e9ecu, 0xd4d8dce0u, 0xc2c7cbcfu, 0xb3b6babeu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xf0f2f4f6u); }
        case 37u: { v = vec4<u32>(0xe5e8ebeeu, 0xd6dadee2u, 0xc4c9cdd1u, 0xb4b8bcc0u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xfafbfcfdu, 0xf2f4f6f8u); }
        case 39u: { v = vec4<u32>(0xe7eaedefu, 0xd8dce0e4u, 0xc7cbd0d4u, 0xb6babec3u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f5f7f9u); }
        case 41u: { v = vec4<u32>(0xe9eceff1u, 0xdbdfe2e6u, 0xcaced2d7u, 0xb9bdc1c5u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf5f7f9fau); }
        case 43u: { v = vec4<u32>(0xebeef1f3u, 0xdee1e5e8u, 0xcdd1d5dau, 0xbcc0c4c9u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 45u: { v = vec4<u32>(0xedf0f2f5u, 0xe0e4e7ebu, 0xd0d4d9ddu, 0xbfc3c8ccu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf8f9fbfcu); }
        case 47u: { v = vec4<u32>(0xeff2f4f6u, 0xe3e7eaedu, 0xd4d8dce0u, 0xc3c7cbd0u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf9fafbfcu); }
        case 49u: { v = vec4<u32>(0xf1f4f6f7u, 0xe6e9ecefu, 0xd8dcdfe3u, 0xc7cbcfd4u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xfafbfcfdu); }
        case 51u: { v = vec4<u32>(0xf3f5f7f9u, 0xe9eceff1u, 0xdbdfe3e6u, 0xccd0d4d8u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfdfdu); }
        case 53u: { v = vec4<u32>(0xf5f7f8fau, 0xeceff1f3u, 0xdfe3e6e9u, 0xd0d4d8dcu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 55u: { v = vec4<u32>(0xf7f8fafbu, 0xeff1f3f5u, 0xe4e7eaecu, 0xd5d9dde0u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 57u: { v = vec4<u32>(0xf8f9fbfbu, 0xf1f3f5f7u, 0xe8eaedefu, 0xdbdee1e5u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 59u: { v = vec4<u32>(0xfafbfbfcu, 0xf4f6f7f8u, 0xeceef0f2u, 0xe0e3e6e9u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfdfefefeu); }
        case 61u: { v = vec4<u32>(0xfbfcfcfdu, 0xf6f7f9fau, 0xeff1f3f5u, 0xe6e8ebedu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefefeu); }
        case 63u: { v = vec4<u32>(0xfcfcfdfdu, 0xf8f9fafbu, 0xf2f4f5f7u, 0xeaeceff0u); }
        default: {}
      }
    }
    case 13u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefefeu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfdfdfefeu, 0xfcfdfdfdu, 0xfcfcfcfcu, 0xfbfbfbfbu); }
        case 4u: { v = vec4<u32>(0xece4f6ffu, 0xfbfaf7f3u, 0xfcfcfcfcu, 0xfbfcfcfcu); }
        case 5u: { v = vec4<u32>(0xfafafbfbu, 0xf7f8f9f9u, 0xf5f6f6f7u, 0xf2f3f4f4u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf6f4f0eau, 0xfafaf9f8u, 0xf9f9fafau); }
        case 7u: { v = vec4<u32>(0xf6f6f7f8u, 0xf2f3f4f5u, 0xedeff0f1u, 0xe9eaebecu); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf1eee9e6u, 0xf7f7f6f4u, 0xf6f6f7f7u); }
        case 9u: { v = vec4<u32>(0xf1f3f4f5u, 0xecedeff0u, 0xe6e7e9eau, 0xe0e1e3e4u); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e7e8u, 0xf4f3f2f0u, 0xf3f4f4f4u); }
        case 11u: { v = vec4<u32>(0xedeff0f2u, 0xe6e8eaecu, 0xdfe1e2e4u, 0xd7d9dbddu); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e8eeu, 0xf1f0efecu, 0xf0f1f2f2u); }
        case 13u: { v = vec4<u32>(0xeaecedefu, 0xe1e3e6e8u, 0xd8dadddfu, 0xd0d2d4d6u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe9e9edf4u, 0xefeeeceau, 0xeeeff0f0u); }
        case 15u: { v = vec4<u32>(0xe7e9ebedu, 0xdddfe2e4u, 0xd3d5d8dau, 0xc9cbced0u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaecf2f8u, 0xedecebeau, 0xecedeeeeu); }
        case 17u: { v = vec4<u32>(0xe4e6e9ebu, 0xd9dcdfe1u, 0xced0d3d6u, 0xc3c6c8cbu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xedf0f6fbu, 0xecebebebu, 0xebecececu); }
        case 19u: { v = vec4<u32>(0xe2e5e7e9u, 0xd6d9dcdfu, 0xcacdd0d3u, 0xbec1c4c7u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xecebecedu, 0xeaebebecu); }
        case 21u: { v = vec4<u32>(0xe1e3e6e8u, 0xd4d7dadeu, 0xc6cacdd0u, 0xbabdc0c3u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xecedeef0u, 0xe9eaebecu); }
        case 23u: { v = vec4<u32>(0xe0e3e5e7u, 0xd2d6d9ddu, 0xc4c7cbcfu, 0xb7babdc1u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6fafcfeu, 0xedeef0f3u, 0xe9eaebecu); }
        case 25u: { v = vec4<u32>(0xdfe2e5e7u, 0xd1d5d9dcu, 0xc2c6cacdu, 0xb5b8bbbfu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeff1f3f6u, 0xe9ebecedu); }
        case 27u: { v = vec4<u32>(0xdfe2e5e7u, 0xd1d5d8dcu, 0xc1c5c9cdu, 0xb3b7babeu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xf1f3f5f8u, 0xeaecedefu); }
        case 29u: { v = vec4<u32>(0xe0e3e6e8u, 0xd1d5d9ddu, 0xc1c5c9cdu, 0xb2b6b9bdu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf3f5f7fau, 0xebedeff1u); }
        case 31u: { v = vec4<u32>(0xe1e4e7e9u, 0xd2d6daddu, 0xc1c5c9ceu, 0xb2b6b9bdu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f7f9fbu, 0xedeff1f3u); }
        case 33u: { v = vec4<u32>(0xe2e5e8ebu, 0xd3d7dbdfu, 0xc2c6cacfu, 0xb2b6babeu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fafcu, 0xeef0f2f4u); }
        case 35u: { v = vec4<u32>(0xe4e7eaecu, 0xd4d9dde0u, 0xc3c8ccd0u, 0xb3b7bbbfu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafbfdu, 0xf0f2f4f6u); }
        case 37u: { v = vec4<u32>(0xe5e8ebeeu, 0xd6dadee2u, 0xc5c9ced2u, 0xb5b8bdc1u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xf2f4f6f8u); }
        case 39u: { v = vec4<u32>(0xe7eaedefu, 0xd9dde0e4u, 0xc7ccd0d4u, 0xb6babfc3u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf3f5f7f9u); }
        case 41u: { v = vec4<u32>(0xe9eceff1u, 0xdbdfe3e6u, 0xcaced3d7u, 0xb9bdc1c5u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf5f7f8fau); }
        case 43u: { v = vec4<u32>(0xebeef0f3u, 0xdde1e5e8u, 0xcdd1d5d9u, 0xbbc0c4c8u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 45u: { v = vec4<u32>(0xedf0f2f4u, 0xe0e4e7eau, 0xd0d4d8dcu, 0xbec3c7cbu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf8f9fafcu); }
        case 47u: { v = vec4<u32>(0xeff2f4f6u, 0xe3e6eaecu, 0xd3d7dbdfu, 0xc2c6cacfu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf9fafbfcu); }
        case 49u: { v = vec4<u32>(0xf1f3f5f7u, 0xe6e9ecefu, 0xd7dbdfe2u, 0xc6caced2u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xfafbfcfdu); }
        case 51u: { v = vec4<u32>(0xf3f5f7f8u, 0xe8ebeef1u, 0xdadee2e5u, 0xcaced2d6u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfcfdu); }
        case 53u: { v = vec4<u32>(0xf5f6f8f9u, 0xebeef0f3u, 0xdee2e5e8u, 0xced2d6dau); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfeu); }
        case 55u: { v = vec4<u32>(0xf6f8f9fau, 0xeef0f2f4u, 0xe2e5e8ebu, 0xd3d7dbdeu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 57u: { v = vec4<u32>(0xf8f9fafbu, 0xf0f2f4f6u, 0xe6e9ebeeu, 0xd8dcdfe3u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 59u: { v = vec4<u32>(0xf9fafbfcu, 0xf3f5f6f8u, 0xeaeceff1u, 0xdde1e4e7u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 61u: { v = vec4<u32>(0xfafbfcfdu, 0xf5f6f8f9u, 0xedeff1f3u, 0xe3e6e8ebu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfdfefefeu); }
        case 63u: { v = vec4<u32>(0xfbfcfcfdu, 0xf7f8f9fau, 0xf0f2f4f5u, 0xe7e9eceeu); }
        default: {}
      }
    }
    case 14u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfdfefefeu, 0xfdfdfdfdu, 0xfcfcfcfcu, 0xfbfbfbfcu); }
        case 4u: { v = vec4<u32>(0xece4f6ffu, 0xfbfaf7f3u, 0xfcfcfcfcu, 0xfcfcfcfcu); }
        case 5u: { v = vec4<u32>(0xfafbfbfbu, 0xf8f9f9fau, 0xf6f6f7f8u, 0xf3f4f5f5u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf6f4f0eau, 0xfafaf9f8u, 0xf9fafafau); }
        case 7u: { v = vec4<u32>(0xf6f7f8f9u, 0xf3f4f5f6u, 0xeff0f1f2u, 0xebecedeeu); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf1eee9e5u, 0xf7f7f6f4u, 0xf6f7f7f8u); }
        case 9u: { v = vec4<u32>(0xf2f4f5f6u, 0xedeff0f1u, 0xe8e9eaecu, 0xe2e3e5e6u); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e6e8u, 0xf4f4f2f0u, 0xf4f4f5f5u); }
        case 11u: { v = vec4<u32>(0xeff0f1f3u, 0xe8eaebedu, 0xe1e3e4e6u, 0xdadbdddfu); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e8eeu, 0xf2f0efecu, 0xf1f2f2f2u); }
        case 13u: { v = vec4<u32>(0xebedeff0u, 0xe3e5e7e9u, 0xdbdddfe1u, 0xd2d4d6d8u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe9e9edf4u, 0xefeeeceau, 0xeff0f0f0u); }
        case 15u: { v = vec4<u32>(0xe8eaeceeu, 0xdfe1e4e6u, 0xd5d7dadcu, 0xcbced0d2u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaecf1f8u, 0xedecebeau, 0xedeeeeeeu); }
        case 17u: { v = vec4<u32>(0xe6e8eaecu, 0xdbdee1e3u, 0xd0d3d6d8u, 0xc6c8cbcdu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xedf0f6fbu, 0xecebebebu, 0xebecedecu); }
        case 19u: { v = vec4<u32>(0xe4e6e8eau, 0xd8dbdee1u, 0xcccfd2d5u, 0xc1c3c6c9u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xebebecedu, 0xeaebececu); }
        case 21u: { v = vec4<u32>(0xe2e5e7e9u, 0xd6d9dcdfu, 0xc9cccfd2u, 0xbcbfc2c5u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xececeef0u, 0xeaebebecu); }
        case 23u: { v = vec4<u32>(0xe1e4e6e8u, 0xd4d8dbdeu, 0xc6cacdd1u, 0xb9bcbfc3u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6fafcfeu, 0xedeef0f3u, 0xe9ebebecu); }
        case 25u: { v = vec4<u32>(0xe1e3e6e8u, 0xd3d7daddu, 0xc4c8cccfu, 0xb7babdc1u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeff0f3f5u, 0xeaebecedu); }
        case 27u: { v = vec4<u32>(0xe0e3e6e8u, 0xd2d6daddu, 0xc3c7cbcfu, 0xb5b8bcbfu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xf1f3f5f8u, 0xeaecedefu); }
        case 29u: { v = vec4<u32>(0xe1e4e6e9u, 0xd2d6dadeu, 0xc2c6caceu, 0xb4b7bbbfu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf3f5f7f9u, 0xebedeff1u); }
        case 31u: { v = vec4<u32>(0xe2e5e7e9u, 0xd3d7dbdeu, 0xc2c7cbcfu, 0xb3b7babeu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf5f7f9fbu, 0xedeff1f2u); }
        case 33u: { v = vec4<u32>(0xe3e6e8ebu, 0xd4d8dcdfu, 0xc3c7cbd0u, 0xb3b7bbbfu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xeef0f2f4u); }
        case 35u: { v = vec4<u32>(0xe4e7eaecu, 0xd5d9dde1u, 0xc4c8cdd1u, 0xb4b7bcc0u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafbfdu, 0xf0f2f4f6u); }
        case 37u: { v = vec4<u32>(0xe6e9ebeeu, 0xd7dbdfe2u, 0xc5caced3u, 0xb5b9bdc1u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xf1f4f6f7u); }
        case 39u: { v = vec4<u32>(0xe7eaedefu, 0xd9dde1e4u, 0xc7ccd0d5u, 0xb6babfc3u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf3f5f7f9u); }
        case 41u: { v = vec4<u32>(0xe9eceff1u, 0xdbdfe3e6u, 0xcaced3d7u, 0xb8bcc1c5u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf5f7f8fau); }
        case 43u: { v = vec4<u32>(0xebeef0f3u, 0xdde1e5e8u, 0xccd1d5d9u, 0xbabfc3c8u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8f9fbu); }
        case 45u: { v = vec4<u32>(0xedf0f2f4u, 0xe0e3e7eau, 0xcfd3d8dcu, 0xbdc2c6cbu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf7f9fafcu); }
        case 47u: { v = vec4<u32>(0xeff1f3f6u, 0xe2e6e9ecu, 0xd2d6dbdfu, 0xc0c5c9ceu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 49u: { v = vec4<u32>(0xf1f3f5f7u, 0xe5e8ebeeu, 0xd5dadee1u, 0xc4c8cdd1u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 51u: { v = vec4<u32>(0xf2f4f6f8u, 0xe8ebedf0u, 0xd9dde1e4u, 0xc8ccd1d5u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 53u: { v = vec4<u32>(0xf4f6f8f9u, 0xeaedf0f2u, 0xdde0e4e7u, 0xccd0d4d9u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 55u: { v = vec4<u32>(0xf6f7f9fau, 0xedeff2f4u, 0xe0e4e7eau, 0xd0d5d9dcu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 57u: { v = vec4<u32>(0xf7f8fafbu, 0xeff1f3f5u, 0xe4e7eaedu, 0xd5d9dde0u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfcfdfefeu); }
        case 59u: { v = vec4<u32>(0xf8fafbfcu, 0xf1f3f5f7u, 0xe7eaedefu, 0xdadee1e4u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 61u: { v = vec4<u32>(0xf9fafbfcu, 0xf4f5f7f8u, 0xebedf0f2u, 0xdfe2e5e8u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfdfefefeu); }
        case 63u: { v = vec4<u32>(0xfafbfcfdu, 0xf5f7f8f9u, 0xedf0f2f3u, 0xe3e6e9ebu); }
        default: {}
      }
    }
    case 15u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfdfefefeu, 0xfdfdfdfdu, 0xfcfcfcfdu, 0xfbfbfcfcu); }
        case 4u: { v = vec4<u32>(0xece4f6ffu, 0xfbfaf7f3u, 0xfdfcfcfcu, 0xfcfcfcfdu); }
        case 5u: { v = vec4<u32>(0xfbfbfbfcu, 0xf9f9fafau, 0xf7f7f8f8u, 0xf4f5f5f6u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf6f4f0eau, 0xfafaf9f8u, 0xfafafafau); }
        case 7u: { v = vec4<u32>(0xf7f8f8f9u, 0xf4f5f5f6u, 0xf0f1f2f3u, 0xecedeeefu); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf1eee9e5u, 0xf8f7f6f4u, 0xf7f7f8f8u); }
        case 9u: { v = vec4<u32>(0xf3f4f5f6u, 0xeef0f1f2u, 0xe9ebecedu, 0xe4e5e6e8u); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e6e8u, 0xf5f4f2f0u, 0xf4f5f5f5u); }
        case 11u: { v = vec4<u32>(0xf0f1f2f3u, 0xe9ebedeeu, 0xe3e4e6e8u, 0xdcdddfe1u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xe9e7e8eeu, 0xf2f1efecu, 0xf2f2f3f2u); }
        case 13u: { v = vec4<u32>(0xeceeeff1u, 0xe5e7e9ebu, 0xdcdfe1e3u, 0xd4d6d8dau); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe8e9ecf4u, 0xefeeeceau, 0xeff0f0f0u); }
        case 15u: { v = vec4<u32>(0xe9ebedeeu, 0xe1e3e5e7u, 0xd7d9dcdeu, 0xced0d2d5u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaecf1f8u, 0xedecebeau, 0xedeeeeeeu); }
        case 17u: { v = vec4<u32>(0xe7e9ebecu, 0xdde0e2e5u, 0xd2d5d8dau, 0xc8cacdd0u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xecf0f6fbu, 0xecebeaebu, 0xecedededu); }
        case 19u: { v = vec4<u32>(0xe5e7e9ebu, 0xdadde0e2u, 0xced1d4d7u, 0xc3c5c8cbu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xebebecedu, 0xebebececu); }
        case 21u: { v = vec4<u32>(0xe3e6e8e9u, 0xd8dbdee1u, 0xcbced1d4u, 0xbec1c4c7u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xececedf0u, 0xeaebebecu); }
        case 23u: { v = vec4<u32>(0xe2e5e7e9u, 0xd6d9dcdfu, 0xc8cbcfd2u, 0xbbbec1c5u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xedeef0f3u, 0xeaebebecu); }
        case 25u: { v = vec4<u32>(0xe2e4e6e8u, 0xd4d8dbdfu, 0xc6cacdd1u, 0xb8bbbfc2u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeef0f2f5u, 0xeaebecedu); }
        case 27u: { v = vec4<u32>(0xe1e4e6e8u, 0xd4d7dbdeu, 0xc4c8ccd0u, 0xb6babdc1u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f8u, 0xeaecedefu); }
        case 29u: { v = vec4<u32>(0xe2e4e7e9u, 0xd4d7dbdeu, 0xc4c8ccd0u, 0xb5b8bcc0u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f5f7f9u, 0xebedeff0u); }
        case 31u: { v = vec4<u32>(0xe2e5e7eau, 0xd4d8dcdfu, 0xc3c8ccd0u, 0xb4b8bbbfu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f7f9fbu, 0xedeff0f2u); }
        case 33u: { v = vec4<u32>(0xe3e6e8ebu, 0xd5d9dce0u, 0xc4c8ccd0u, 0xb3b7bbc0u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xeef0f2f4u); }
        case 35u: { v = vec4<u32>(0xe4e7eaecu, 0xd6dadee1u, 0xc5c9cdd2u, 0xb4b8bcc0u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafbfdu, 0xf0f2f4f6u); }
        case 37u: { v = vec4<u32>(0xe6e9ebeeu, 0xd7dbdfe2u, 0xc6cacfd3u, 0xb4b9bdc1u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xf1f3f5f7u); }
        case 39u: { v = vec4<u32>(0xe7eaedefu, 0xd9dde1e4u, 0xc7ccd0d5u, 0xb6babec3u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf3f5f7f9u); }
        case 41u: { v = vec4<u32>(0xe9eceef1u, 0xdbdfe2e6u, 0xc9ced2d7u, 0xb7bcc0c5u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8fau); }
        case 43u: { v = vec4<u32>(0xebedf0f2u, 0xdde1e4e8u, 0xccd0d5d9u, 0xb9bec2c7u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfefeu, 0xf6f8f9fbu); }
        case 45u: { v = vec4<u32>(0xedeff2f4u, 0xdfe3e6eau, 0xced3d7dbu, 0xbcc0c5cau); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f9fafbu); }
        case 47u: { v = vec4<u32>(0xeef1f3f5u, 0xe2e5e9ecu, 0xd1d6dadeu, 0xbfc3c8cdu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 49u: { v = vec4<u32>(0xf0f2f5f6u, 0xe4e8ebeeu, 0xd4d8dde0u, 0xc2c7cbd0u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 51u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedefu, 0xd7dcdfe3u, 0xc6cacfd3u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 53u: { v = vec4<u32>(0xf3f5f7f9u, 0xe9eceff1u, 0xdbdfe2e6u, 0xc9ced2d7u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfdfdu); }
        case 55u: { v = vec4<u32>(0xf5f7f8fau, 0xebeef1f3u, 0xdee2e5e8u, 0xced2d6dau); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 57u: { v = vec4<u32>(0xf6f8f9fau, 0xeef0f2f4u, 0xe2e5e8ebu, 0xd2d6dadeu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 59u: { v = vec4<u32>(0xf8f9fafbu, 0xf0f2f4f6u, 0xe5e8ebeeu, 0xd7dbdee2u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 61u: { v = vec4<u32>(0xf9fafbfcu, 0xf2f4f6f7u, 0xe8ebedf0u, 0xdbdfe2e5u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 63u: { v = vec4<u32>(0xf9fbfbfcu, 0xf3f5f7f8u, 0xebedeff2u, 0xdfe2e5e8u); }
        default: {}
      }
    }
    case 16u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfdfdfdfdu, 0xfcfcfdfdu, 0xfcfcfcfcu); }
        case 4u: { v = vec4<u32>(0xece4f6ffu, 0xfbfaf7f3u, 0xfdfdfcfcu, 0xfcfcfdfdu); }
        case 5u: { v = vec4<u32>(0xfbfbfcfcu, 0xf9fafafau, 0xf7f8f8f9u, 0xf5f6f6f7u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0eau, 0xfafaf9f8u, 0xfafafafau); }
        case 7u: { v = vec4<u32>(0xf8f8f9f9u, 0xf4f5f6f7u, 0xf1f2f3f4u, 0xedeeeff0u); }
        case 8u: { v = vec4<u32>(0xe9f6feffu, 0xf1eee9e5u, 0xf8f7f6f4u, 0xf7f8f8f8u); }
        case 9u: { v = vec4<u32>(0xf4f5f6f7u, 0xf0f1f2f3u, 0xeaecedeeu, 0xe5e7e8e9u); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e6e8u, 0xf5f4f2f0u, 0xf5f5f5f5u); }
        case 11u: { v = vec4<u32>(0xf1f2f3f4u, 0xebeceeefu, 0xe4e6e7e9u, 0xdddfe1e2u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xe9e7e8eeu, 0xf2f1efecu, 0xf2f3f3f3u); }
        case 13u: { v = vec4<u32>(0xedeff0f1u, 0xe6e8eaecu, 0xdee0e2e4u, 0xd6d8dadcu); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe8e9ecf4u, 0xefeeeceau, 0xf0f0f1f0u); }
        case 15u: { v = vec4<u32>(0xebeceeefu, 0xe2e4e7e9u, 0xd9dbdee0u, 0xd0d2d4d6u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaecf1f8u, 0xedecebe9u, 0xeeeeefeeu); }
        case 17u: { v = vec4<u32>(0xe8eaecedu, 0xdfe1e4e6u, 0xd4d7d9dcu, 0xcacccfd1u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xecf0f6fbu, 0xecebeaebu, 0xecedededu); }
        case 19u: { v = vec4<u32>(0xe6e8eaebu, 0xdcdee1e4u, 0xd0d3d6d9u, 0xc5c7cacdu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xebebebedu, 0xebecececu); }
        case 21u: { v = vec4<u32>(0xe4e7e8eau, 0xd9dcdfe2u, 0xccd0d3d6u, 0xc0c3c6c9u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xececedf0u, 0xeaebebecu); }
        case 23u: { v = vec4<u32>(0xe3e5e7e9u, 0xd7dadde0u, 0xcacdd0d4u, 0xbcc0c3c6u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xedeef0f3u, 0xeaebebecu); }
        case 25u: { v = vec4<u32>(0xe2e5e7e9u, 0xd6d9dce0u, 0xc7cbcfd2u, 0xb9bdc0c4u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeef0f2f5u, 0xeaebecedu); }
        case 27u: { v = vec4<u32>(0xe2e5e7e9u, 0xd5d9dcdfu, 0xc6cacdd1u, 0xb7bbbec2u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f7u, 0xebecedefu); }
        case 29u: { v = vec4<u32>(0xe2e5e7e9u, 0xd5d8dcdfu, 0xc5c9cdd1u, 0xb5b9bdc1u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebedeff0u); }
        case 31u: { v = vec4<u32>(0xe3e5e8eau, 0xd5d8dce0u, 0xc4c8cdd1u, 0xb4b8bcc0u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f6f9fbu, 0xedeef0f2u); }
        case 33u: { v = vec4<u32>(0xe3e6e9ebu, 0xd5d9dde0u, 0xc4c9cdd1u, 0xb4b8bcc0u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xeef0f2f4u); }
        case 35u: { v = vec4<u32>(0xe4e7eaecu, 0xd6dadee1u, 0xc5c9ced2u, 0xb4b8bcc0u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8f9fbfdu, 0xf0f2f4f6u); }
        case 37u: { v = vec4<u32>(0xe6e9ebedu, 0xd7dbdfe3u, 0xc6cacfd3u, 0xb4b8bdc1u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xf1f3f5f7u); }
        case 39u: { v = vec4<u32>(0xe7eaedefu, 0xd9dde1e4u, 0xc7ccd0d5u, 0xb5b9bec3u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xf3f5f7f8u); }
        case 41u: { v = vec4<u32>(0xe9eceef0u, 0xdbdfe2e6u, 0xc9cdd2d6u, 0xb6bbc0c4u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8fau); }
        case 43u: { v = vec4<u32>(0xeaedf0f2u, 0xdde0e4e7u, 0xcbd0d4d8u, 0xb8bdc1c6u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfefeu, 0xf5f7f9fau); }
        case 45u: { v = vec4<u32>(0xeceff1f3u, 0xdfe2e6e9u, 0xcdd2d6dbu, 0xbabfc4c9u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f8fafbu); }
        case 47u: { v = vec4<u32>(0xeef0f3f5u, 0xe1e5e8ebu, 0xd0d4d9ddu, 0xbdc2c6cbu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8f9fbfcu); }
        case 49u: { v = vec4<u32>(0xf0f2f4f6u, 0xe3e7eaedu, 0xd3d7dbdfu, 0xc0c5c9ceu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fafbfcu); }
        case 51u: { v = vec4<u32>(0xf1f3f5f7u, 0xe5e9ecefu, 0xd6dadee2u, 0xc3c8ccd1u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xfafbfcfdu); }
        case 53u: { v = vec4<u32>(0xf3f5f7f8u, 0xe8ebeef0u, 0xd9dde1e4u, 0xc7cbd0d4u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfcfdu); }
        case 55u: { v = vec4<u32>(0xf4f6f8f9u, 0xeaedf0f2u, 0xdce0e3e7u, 0xcacfd3d8u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 57u: { v = vec4<u32>(0xf5f7f9fau, 0xeceff1f4u, 0xdfe3e6e9u, 0xcfd3d7dbu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 59u: { v = vec4<u32>(0xf7f8fafbu, 0xeef1f3f5u, 0xe2e6e9ecu, 0xd3d7dbdfu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu); }
        case 61u: { v = vec4<u32>(0xf8f9fafbu, 0xf0f2f4f6u, 0xe5e8ebeeu, 0xd7dbdfe2u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 63u: { v = vec4<u32>(0xf9fafbfcu, 0xf2f4f5f7u, 0xe8ebedefu, 0xdbdfe2e5u); }
        default: {}
      }
    }
    case 17u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfdfdfdfeu, 0xfcfdfdfdu, 0xfcfcfcfcu); }
        case 4u: { v = vec4<u32>(0xece4f6ffu, 0xfbfaf7f3u, 0xfdfdfcfcu, 0xfcfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfbfbfcfcu, 0xfafafafbu, 0xf8f8f9f9u, 0xf6f6f7f7u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0eau, 0xfafaf9f8u, 0xfafafbfbu); }
        case 7u: { v = vec4<u32>(0xf8f9f9fau, 0xf5f6f7f7u, 0xf2f3f3f4u, 0xeeeff0f1u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf1eee9e5u, 0xf8f7f6f4u, 0xf8f8f8f8u); }
        case 9u: { v = vec4<u32>(0xf5f6f6f7u, 0xf0f2f3f4u, 0xecedeeefu, 0xe7e8e9eau); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e6e8u, 0xf5f4f2f0u, 0xf5f6f6f6u); }
        case 11u: { v = vec4<u32>(0xf1f3f4f4u, 0xecedeff0u, 0xe6e7e9eau, 0xdfe1e2e4u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xe9e7e8eeu, 0xf2f1efecu, 0xf3f3f3f3u); }
        case 13u: { v = vec4<u32>(0xeef0f1f2u, 0xe7e9ebedu, 0xe0e2e4e6u, 0xd8dadcdeu); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe8e9ecf4u, 0xefeeeceau, 0xf0f1f1f0u); }
        case 15u: { v = vec4<u32>(0xebedeef0u, 0xe3e6e8eau, 0xdadddfe1u, 0xd1d4d6d8u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaecf1f8u, 0xedecebe9u, 0xeeefefeeu); }
        case 17u: { v = vec4<u32>(0xe9ebeceeu, 0xe0e2e5e7u, 0xd6d8dbddu, 0xcbced0d3u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xecf0f6fbu, 0xecebeaebu, 0xededededu); }
        case 19u: { v = vec4<u32>(0xe7e9eaecu, 0xdde0e2e5u, 0xd1d4d7dau, 0xc6c9cccfu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xebebebedu, 0xebecececu); }
        case 21u: { v = vec4<u32>(0xe5e7e9eau, 0xdadde0e3u, 0xced1d4d7u, 0xc2c5c8cbu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xececedf0u, 0xebebebecu); }
        case 23u: { v = vec4<u32>(0xe4e6e8e9u, 0xd8dcdfe1u, 0xcbced2d5u, 0xbec1c4c8u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xedeef0f2u, 0xeaebececu); }
        case 25u: { v = vec4<u32>(0xe3e5e7e9u, 0xd7dadde0u, 0xc9ccd0d3u, 0xbbbec1c5u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeef0f2f5u, 0xeaebecedu); }
        case 27u: { v = vec4<u32>(0xe3e5e7e9u, 0xd6d9dde0u, 0xc7cbced2u, 0xb8bcbfc3u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f7u, 0xebecedeeu); }
        case 29u: { v = vec4<u32>(0xe3e5e7e9u, 0xd5d9dce0u, 0xc6caced1u, 0xb6babec2u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebedeff0u); }
        case 31u: { v = vec4<u32>(0xe3e5e8eau, 0xd5d9dde0u, 0xc5c9cdd1u, 0xb5b9bdc1u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f6f9fbu, 0xedeef0f2u); }
        case 33u: { v = vec4<u32>(0xe4e6e9ebu, 0xd6d9dde0u, 0xc5c9cdd1u, 0xb4b8bcc0u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xeef0f2f4u); }
        case 35u: { v = vec4<u32>(0xe4e7eaecu, 0xd6dadee1u, 0xc5c9ced2u, 0xb3b8bcc0u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfcu, 0xeff1f3f5u); }
        case 37u: { v = vec4<u32>(0xe6e8ebedu, 0xd7dbdfe2u, 0xc6cacfd3u, 0xb4b8bcc1u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fafcfdu, 0xf1f3f5f7u); }
        case 39u: { v = vec4<u32>(0xe7eaecefu, 0xd9dde0e4u, 0xc7cbd0d4u, 0xb4b9bdc2u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfdu, 0xf2f4f6f8u); }
        case 41u: { v = vec4<u32>(0xe8ebeef0u, 0xdadee2e5u, 0xc8cdd1d6u, 0xb5babfc3u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8f9u); }
        case 43u: { v = vec4<u32>(0xeaedeff2u, 0xdce0e4e7u, 0xcacfd3d8u, 0xb7bbc0c5u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu, 0xf5f7f9fau); }
        case 45u: { v = vec4<u32>(0xeceef1f3u, 0xdee2e5e9u, 0xccd1d5dau, 0xb9bdc2c7u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 47u: { v = vec4<u32>(0xedf0f2f4u, 0xe0e4e7eau, 0xced3d7dcu, 0xbbc0c5c9u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf8f9fbfcu); }
        case 49u: { v = vec4<u32>(0xeff1f4f6u, 0xe2e6e9ecu, 0xd1d5dadeu, 0xbdc2c7ccu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf9fafbfcu); }
        case 51u: { v = vec4<u32>(0xf0f3f5f7u, 0xe4e8ebeeu, 0xd4d8dce0u, 0xc0c5cacfu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 53u: { v = vec4<u32>(0xf2f4f6f8u, 0xe6eaedefu, 0xd6dbdfe3u, 0xc3c8cdd2u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 55u: { v = vec4<u32>(0xf3f5f7f9u, 0xe8ebeef1u, 0xd9dde1e5u, 0xc7ccd0d5u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 57u: { v = vec4<u32>(0xf5f6f8fau, 0xeaedf0f2u, 0xdce0e4e7u, 0xcbcfd4d8u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfeu); }
        case 59u: { v = vec4<u32>(0xf6f7f9fau, 0xeceff2f4u, 0xdfe3e6eau, 0xcfd3d7dcu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 61u: { v = vec4<u32>(0xf7f8fafbu, 0xeef1f3f5u, 0xe2e6e9ecu, 0xd3d7dbdfu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu); }
        case 63u: { v = vec4<u32>(0xf8f9fafbu, 0xf0f2f4f6u, 0xe5e8ebedu, 0xd7dadee1u); }
        default: {}
      }
    }
    case 18u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfdfdfefeu, 0xfdfdfdfdu, 0xfcfcfcfdu); }
        case 4u: { v = vec4<u32>(0xece4f6ffu, 0xfbfaf7f3u, 0xfdfdfcfcu, 0xfcfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfbfcfcfcu, 0xfafafbfbu, 0xf8f9f9f9u, 0xf6f7f7f8u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0eau, 0xfbfaf9f8u, 0xfafbfbfbu); }
        case 7u: { v = vec4<u32>(0xf8f9fafau, 0xf6f6f7f8u, 0xf2f3f4f5u, 0xeff0f1f2u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf1eee9e5u, 0xf8f7f6f4u, 0xf8f8f8f8u); }
        case 9u: { v = vec4<u32>(0xf5f6f7f7u, 0xf1f2f3f4u, 0xedeeeff0u, 0xe8e9eaebu); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e6e8u, 0xf5f4f2f0u, 0xf5f6f6f6u); }
        case 11u: { v = vec4<u32>(0xf2f3f4f5u, 0xedeef0f1u, 0xe7e8eaebu, 0xe0e2e4e5u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xe9e7e8eeu, 0xf2f1efecu, 0xf3f3f3f3u); }
        case 13u: { v = vec4<u32>(0xeff0f1f2u, 0xe9eaeceeu, 0xe1e3e5e7u, 0xd9dbdddfu); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe8e9ecf4u, 0xf0eeeceau, 0xf1f1f1f1u); }
        case 15u: { v = vec4<u32>(0xeceeeff0u, 0xe5e7e9ebu, 0xdcdee0e2u, 0xd3d5d7dau); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaecf1f8u, 0xedecebe9u, 0xefefefeeu); }
        case 17u: { v = vec4<u32>(0xeaebedeeu, 0xe1e3e6e8u, 0xd7dadcdfu, 0xcdcfd2d5u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xecf0f6fbu, 0xecebeaebu, 0xededededu); }
        case 19u: { v = vec4<u32>(0xe8e9ebecu, 0xdee1e3e5u, 0xd3d6d9dbu, 0xc8cacdd0u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xebebebedu, 0xececececu); }
        case 21u: { v = vec4<u32>(0xe6e8eaebu, 0xdbdee1e4u, 0xcfd2d5d8u, 0xc3c6c9ccu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xececedf0u, 0xebebececu); }
        case 23u: { v = vec4<u32>(0xe5e7e8eau, 0xd9dcdfe2u, 0xcccfd3d6u, 0xbfc2c5c9u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xedeef0f2u, 0xeaebececu); }
        case 25u: { v = vec4<u32>(0xe4e6e8e9u, 0xd8dbdee1u, 0xcacdd1d4u, 0xbcbfc2c6u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeef0f2f5u, 0xeaebecedu); }
        case 27u: { v = vec4<u32>(0xe3e5e7e9u, 0xd7dadde0u, 0xc8cbcfd3u, 0xb9bcc0c4u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f7u, 0xebecedeeu); }
        case 29u: { v = vec4<u32>(0xe3e5e7e9u, 0xd6dadde0u, 0xc6caced2u, 0xb6babec2u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebedeef0u); }
        case 31u: { v = vec4<u32>(0xe3e6e8eau, 0xd6d9dde0u, 0xc5caced2u, 0xb5b9bdc1u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f6f8fbu, 0xeceef0f2u); }
        case 33u: { v = vec4<u32>(0xe4e6e9ebu, 0xd6dadde1u, 0xc5c9ced2u, 0xb4b8bcc0u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xeef0f2f4u); }
        case 35u: { v = vec4<u32>(0xe4e7eaecu, 0xd6dadee1u, 0xc5c9ced2u, 0xb3b7bcc0u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeff1f3f5u); }
        case 37u: { v = vec4<u32>(0xe5e8ebedu, 0xd7dbdfe2u, 0xc5caced3u, 0xb3b7bcc1u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fafcfdu, 0xf1f3f5f7u); }
        case 39u: { v = vec4<u32>(0xe7e9eceeu, 0xd8dce0e3u, 0xc6cbcfd4u, 0xb3b8bdc1u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfdu, 0xf2f4f6f8u); }
        case 41u: { v = vec4<u32>(0xe8ebedf0u, 0xdadee1e5u, 0xc7ccd1d5u, 0xb4b9bec2u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f6f7f9u); }
        case 43u: { v = vec4<u32>(0xe9eceff1u, 0xdbdfe3e6u, 0xc9ced2d7u, 0xb5babfc4u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf5f7f9fau); }
        case 45u: { v = vec4<u32>(0xebeef0f3u, 0xdde1e4e8u, 0xcbcfd4d9u, 0xb6bbc1c6u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8f9fbu); }
        case 47u: { v = vec4<u32>(0xeceff2f4u, 0xdfe3e6e9u, 0xcdd1d6dau, 0xb8bdc3c8u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf7f9fafcu); }
        case 49u: { v = vec4<u32>(0xeef1f3f5u, 0xe1e4e8ebu, 0xcfd4d8ddu, 0xbbc0c5cau); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 51u: { v = vec4<u32>(0xeff2f4f6u, 0xe3e6eaedu, 0xd1d6dadfu, 0xbdc2c7ccu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fafcfdu); }
        case 53u: { v = vec4<u32>(0xf1f3f5f7u, 0xe5e8ebeeu, 0xd4d8dde1u, 0xc0c5cacfu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 55u: { v = vec4<u32>(0xf2f4f6f8u, 0xe7eaedf0u, 0xd7dbdfe3u, 0xc3c8cdd2u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafcfcfdu); }
        case 57u: { v = vec4<u32>(0xf3f6f7f9u, 0xe8eceff1u, 0xd9dde1e5u, 0xc7ccd0d5u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 59u: { v = vec4<u32>(0xf5f7f8fau, 0xeaedf0f2u, 0xdce0e4e7u, 0xcacfd4d8u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfeu); }
        case 61u: { v = vec4<u32>(0xf6f7f9fau, 0xeceff1f4u, 0xdfe2e6e9u, 0xced3d7dbu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 63u: { v = vec4<u32>(0xf6f8fafbu, 0xedf0f2f5u, 0xe1e4e8ebu, 0xd2d6daddu); }
        default: {}
      }
    }
    case 19u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfdfefefeu, 0xfdfdfdfdu, 0xfcfcfcfdu); }
        case 4u: { v = vec4<u32>(0xece4f6ffu, 0xfbfaf7f3u, 0xfdfdfcfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfcfcfcu, 0xfafbfbfbu, 0xf8f9f9fau, 0xf7f7f8f8u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0eau, 0xfbfafaf8u, 0xfbfbfbfbu); }
        case 7u: { v = vec4<u32>(0xf9f9fafau, 0xf6f7f8f8u, 0xf3f4f5f5u, 0xf0f1f2f2u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf2eee9e6u, 0xf8f7f6f4u, 0xf8f8f9f8u); }
        case 9u: { v = vec4<u32>(0xf6f6f7f8u, 0xf2f3f4f5u, 0xedeff0f1u, 0xe9eaebecu); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e6e8u, 0xf5f4f2f0u, 0xf6f6f6f6u); }
        case 11u: { v = vec4<u32>(0xf3f4f5f5u, 0xeeeff0f1u, 0xe8e9ebecu, 0xe2e3e5e6u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e8eeu, 0xf2f1efecu, 0xf3f4f4f3u); }
        case 13u: { v = vec4<u32>(0xf0f1f2f3u, 0xe9ebedeeu, 0xe2e4e6e8u, 0xdbdddee0u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe9e9ecf4u, 0xf0eeeceau, 0xf1f1f1f1u); }
        case 15u: { v = vec4<u32>(0xedeef0f0u, 0xe6e8eaebu, 0xdddfe1e4u, 0xd4d6d9dbu); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaecf1f8u, 0xeeecebeau, 0xefefefefu); }
        case 17u: { v = vec4<u32>(0xeaecedeeu, 0xe2e4e7e9u, 0xd8dbdde0u, 0xced1d3d6u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xecf0f6fbu, 0xecebeaebu, 0xedeeeeedu); }
        case 19u: { v = vec4<u32>(0xe8eaebedu, 0xdfe2e4e6u, 0xd4d7dadcu, 0xc9ccced1u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xecebebedu, 0xececececu); }
        case 21u: { v = vec4<u32>(0xe6e8eaebu, 0xdcdfe2e4u, 0xd0d3d6d9u, 0xc4c7cacdu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xececedf0u, 0xebecececu); }
        case 23u: { v = vec4<u32>(0xe5e7e9eau, 0xdadde0e3u, 0xcdd0d4d7u, 0xc0c3c6cau); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xedeef0f2u, 0xeaebececu); }
        case 25u: { v = vec4<u32>(0xe4e6e8e9u, 0xd9dcdfe2u, 0xcaced2d5u, 0xbcc0c3c7u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeef0f2f5u, 0xeaebecedu); }
        case 27u: { v = vec4<u32>(0xe3e6e8e9u, 0xd7dbdee1u, 0xc8ccd0d4u, 0xb9bdc1c5u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f7u, 0xebecedeeu); }
        case 29u: { v = vec4<u32>(0xe3e6e8e9u, 0xd6dadde0u, 0xc7cbcfd3u, 0xb7bbbfc3u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebedeef0u); }
        case 31u: { v = vec4<u32>(0xe3e6e8eau, 0xd6dadde0u, 0xc6caced2u, 0xb5b9bdc1u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f6f8fbu, 0xeceef0f2u); }
        case 33u: { v = vec4<u32>(0xe4e6e8ebu, 0xd6dadde1u, 0xc5c9ced2u, 0xb3b8bcc0u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xeeeff1f3u); }
        case 35u: { v = vec4<u32>(0xe4e7e9ecu, 0xd6dadee1u, 0xc5c9ced2u, 0xb2b7bbc0u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeff1f3f5u); }
        case 37u: { v = vec4<u32>(0xe5e8eaedu, 0xd7dbdfe2u, 0xc5c9ced3u, 0xb2b7bbc0u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fafcfdu, 0xf0f2f5f7u); }
        case 39u: { v = vec4<u32>(0xe6e9eceeu, 0xd8dce0e3u, 0xc5cacfd3u, 0xb2b7bcc0u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfcfdu, 0xf2f4f6f8u); }
        case 41u: { v = vec4<u32>(0xe7eaedefu, 0xd9dde1e4u, 0xc6cbd0d4u, 0xb2b7bcc1u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f5f7f9u); }
        case 43u: { v = vec4<u32>(0xe9eceef1u, 0xdadee2e6u, 0xc7ccd1d6u, 0xb3b8bdc2u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8fau); }
        case 45u: { v = vec4<u32>(0xeaedf0f2u, 0xdce0e4e7u, 0xc9ced3d7u, 0xb4b9bec4u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8f9fbu); }
        case 47u: { v = vec4<u32>(0xeceef1f3u, 0xdde1e5e8u, 0xcbd0d4d9u, 0xb6bbc0c5u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf7f8fafbu); }
        case 49u: { v = vec4<u32>(0xedf0f2f5u, 0xdfe3e7eau, 0xcdd1d6dbu, 0xb7bdc2c7u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8f9fbfcu); }
        case 51u: { v = vec4<u32>(0xeef1f4f6u, 0xe1e5e8ebu, 0xcfd4d8ddu, 0xbabfc4cau); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fafbfcu); }
        case 53u: { v = vec4<u32>(0xf0f2f5f7u, 0xe3e6eaedu, 0xd1d6dadfu, 0xbcc2c7ccu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 55u: { v = vec4<u32>(0xf1f4f6f8u, 0xe4e8ebeeu, 0xd3d8dce1u, 0xbfc4c9ceu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 57u: { v = vec4<u32>(0xf2f5f7f8u, 0xe6eaedf0u, 0xd6dadfe3u, 0xc2c7ccd1u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafcfdfdu); }
        case 59u: { v = vec4<u32>(0xf3f6f7f9u, 0xe8ebeef1u, 0xd8dde1e4u, 0xc5cacfd4u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 61u: { v = vec4<u32>(0xf4f6f8fau, 0xeaedf0f2u, 0xdbdfe3e6u, 0xc9ced2d7u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfeu); }
        case 63u: { v = vec4<u32>(0xf5f7f9fau, 0xebeef1f3u, 0xdde1e4e8u, 0xccd1d5d9u); }
        default: {}
      }
    }
    case 20u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfdfefefeu, 0xfdfdfdfdu, 0xfcfcfdfdu); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf7f3u, 0xfdfdfcfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfcfcfdu, 0xfafbfbfbu, 0xf9f9fafau, 0xf7f7f8f8u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0eau, 0xfbfafaf8u, 0xfbfbfbfbu); }
        case 7u: { v = vec4<u32>(0xf9fafafau, 0xf7f7f8f9u, 0xf4f4f5f6u, 0xf1f1f2f3u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf2eee9e6u, 0xf8f7f6f4u, 0xf8f9f9f9u); }
        case 9u: { v = vec4<u32>(0xf6f7f7f8u, 0xf3f3f4f5u, 0xeeeff0f1u, 0xeaebecedu); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e7e8u, 0xf5f4f2f0u, 0xf6f6f6f6u); }
        case 11u: { v = vec4<u32>(0xf3f4f5f6u, 0xeef0f1f2u, 0xe9eaecedu, 0xe3e4e6e7u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e8eeu, 0xf2f1efecu, 0xf4f4f4f3u); }
        case 13u: { v = vec4<u32>(0xf0f1f2f3u, 0xeaecedefu, 0xe3e5e7e9u, 0xdcdee0e1u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe9e9edf4u, 0xf0eeeceau, 0xf1f2f2f1u); }
        case 15u: { v = vec4<u32>(0xedeff0f1u, 0xe7e8eaecu, 0xdee0e2e4u, 0xd5d8dadcu); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaecf1f8u, 0xeeecebeau, 0xeff0efefu); }
        case 17u: { v = vec4<u32>(0xebedeeefu, 0xe3e5e7e9u, 0xd9dcdee1u, 0xcfd2d4d7u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xedf0f6fbu, 0xecebebebu, 0xeeeeeeedu); }
        case 19u: { v = vec4<u32>(0xe9ebecedu, 0xe0e2e5e7u, 0xd5d8dbddu, 0xcacdd0d2u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xecebecedu, 0xecededecu); }
        case 21u: { v = vec4<u32>(0xe7e9eaebu, 0xdde0e3e5u, 0xd1d4d7dau, 0xc5c8cbceu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xececedf0u, 0xebecececu); }
        case 23u: { v = vec4<u32>(0xe6e7e9eau, 0xdbdee1e3u, 0xced1d5d8u, 0xc1c4c7cbu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xedeef0f3u, 0xebebececu); }
        case 25u: { v = vec4<u32>(0xe4e7e8eau, 0xd9dcdfe2u, 0xcbcfd2d6u, 0xbdc0c4c8u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeef0f2f5u, 0xeaebecedu); }
        case 27u: { v = vec4<u32>(0xe4e6e8e9u, 0xd8dbdee1u, 0xc9cdd0d4u, 0xbabdc1c5u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f7u, 0xebecedeeu); }
        case 29u: { v = vec4<u32>(0xe3e6e8e9u, 0xd7dadee1u, 0xc7cbcfd3u, 0xb7bbbfc3u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebedeef0u); }
        case 31u: { v = vec4<u32>(0xe3e6e8eau, 0xd6dadde0u, 0xc6caced2u, 0xb5b9bdc1u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f6f8fbu, 0xeceef0f2u); }
        case 33u: { v = vec4<u32>(0xe3e6e8eau, 0xd6dadde1u, 0xc5c9ced2u, 0xb3b7bcc0u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf6f8fafcu, 0xedeff1f3u); }
        case 35u: { v = vec4<u32>(0xe4e7e9ebu, 0xd6dadee1u, 0xc4c9cdd2u, 0xb2b6bbbfu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeff1f3f5u); }
        case 37u: { v = vec4<u32>(0xe5e8eaecu, 0xd6dadee2u, 0xc4c9cdd2u, 0xb1b5babfu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xf0f2f4f6u); }
        case 39u: { v = vec4<u32>(0xe6e9ebeeu, 0xd7dbdfe2u, 0xc4c9ced3u, 0xb0b5babfu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xf1f4f6f8u); }
        case 41u: { v = vec4<u32>(0xe7eaecefu, 0xd8dce0e4u, 0xc5cacfd3u, 0xb0b5bbc0u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf3f5f7f9u); }
        case 43u: { v = vec4<u32>(0xe8ebeef0u, 0xd9dde1e5u, 0xc6cbd0d5u, 0xb1b6bbc0u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8fau); }
        case 45u: { v = vec4<u32>(0xe9eceff2u, 0xdadfe2e6u, 0xc7ccd1d6u, 0xb1b7bcc2u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf5f7f9fau); }
        case 47u: { v = vec4<u32>(0xebeef0f3u, 0xdce0e4e7u, 0xc8cdd2d7u, 0xb3b8bec3u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 49u: { v = vec4<u32>(0xeceff2f4u, 0xdde1e5e9u, 0xcacfd4d9u, 0xb4babfc5u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf7f9fafcu); }
        case 51u: { v = vec4<u32>(0xedf0f3f5u, 0xdfe3e7eau, 0xccd1d6dau, 0xb6bbc1c6u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 53u: { v = vec4<u32>(0xeff1f4f6u, 0xe0e4e8ebu, 0xced3d8dcu, 0xb8bec3c8u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fafbfcu); }
        case 55u: { v = vec4<u32>(0xf0f2f5f7u, 0xe2e6eaedu, 0xd0d5dadeu, 0xbac0c5cbu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 57u: { v = vec4<u32>(0xf1f3f6f8u, 0xe4e7ebeeu, 0xd2d7dbe0u, 0xbdc3c8cdu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 59u: { v = vec4<u32>(0xf2f4f7f8u, 0xe5e9ecefu, 0xd4d9dde2u, 0xc0c5cbd0u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafcfdfdu); }
        case 61u: { v = vec4<u32>(0xf3f5f7f9u, 0xe7eaeef0u, 0xd7dbdfe3u, 0xc3c8cdd2u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 63u: { v = vec4<u32>(0xf4f6f8fau, 0xe8ebeff1u, 0xd9dde1e5u, 0xc6cbd0d4u); }
        default: {}
      }
    }
    case 21u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfdfdfdfdu, 0xfcfdfdfdu); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf7f3u, 0xfdfdfcfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfcfcfdu, 0xfbfbfbfcu, 0xf9fafafau, 0xf7f8f8f9u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0eau, 0xfbfafaf8u, 0xfbfbfbfbu); }
        case 7u: { v = vec4<u32>(0xf9fafafbu, 0xf7f8f8f9u, 0xf4f5f6f6u, 0xf1f2f3f3u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf2eee9e6u, 0xf8f7f6f4u, 0xf9f9f9f9u); }
        case 9u: { v = vec4<u32>(0xf6f7f8f8u, 0xf3f4f5f6u, 0xeff0f1f2u, 0xeaecedeeu); }
        case 10u: { v = vec4<u32>(0xf1fbffffu, 0xede9e7e8u, 0xf5f4f3f0u, 0xf6f7f6f6u); }
        case 11u: { v = vec4<u32>(0xf4f4f5f6u, 0xeff0f1f3u, 0xe9ebeceeu, 0xe4e5e7e8u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e8eeu, 0xf3f1efedu, 0xf4f4f4f4u); }
        case 13u: { v = vec4<u32>(0xf1f2f3f3u, 0xebedeeefu, 0xe4e6e8e9u, 0xdddfe1e2u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe9e9edf4u, 0xf0eeedeau, 0xf2f2f2f1u); }
        case 15u: { v = vec4<u32>(0xeeeff0f1u, 0xe7e9ebedu, 0xdfe1e3e5u, 0xd6d9dbddu); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaecf2f8u, 0xeeedebeau, 0xf0f0f0efu); }
        case 17u: { v = vec4<u32>(0xecedeeefu, 0xe4e6e8eau, 0xdadddfe2u, 0xd0d3d5d8u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xedf0f6fbu, 0xececebebu, 0xeeeeeeedu); }
        case 19u: { v = vec4<u32>(0xe9ebecedu, 0xe1e3e5e7u, 0xd6d9dbdeu, 0xcbced0d3u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xecececedu, 0xecededecu); }
        case 21u: { v = vec4<u32>(0xe7e9ebecu, 0xdee1e3e5u, 0xd2d5d8dbu, 0xc6c9cccfu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xececeef0u, 0xebecececu); }
        case 23u: { v = vec4<u32>(0xe6e8e9ebu, 0xdcdee1e4u, 0xcfd2d5d8u, 0xc1c5c8cbu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xedeef0f3u, 0xebebececu); }
        case 25u: { v = vec4<u32>(0xe5e7e8eau, 0xdadde0e2u, 0xcccfd3d6u, 0xbdc1c4c8u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeef0f2f5u, 0xebebecedu); }
        case 27u: { v = vec4<u32>(0xe4e6e8e9u, 0xd8dbdee1u, 0xc9cdd1d4u, 0xbabec1c5u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f7u, 0xebecedeeu); }
        case 29u: { v = vec4<u32>(0xe3e6e8e9u, 0xd7dadee1u, 0xc7cbcfd3u, 0xb7bbbfc3u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebedeef0u); }
        case 31u: { v = vec4<u32>(0xe3e6e8eau, 0xd6dadde0u, 0xc5caced2u, 0xb4b8bdc1u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f6f8fau, 0xeceef0f2u); }
        case 33u: { v = vec4<u32>(0xe3e6e8eau, 0xd6d9dde0u, 0xc4c9cdd2u, 0xb2b7bbc0u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f8fafcu, 0xedeff1f3u); }
        case 35u: { v = vec4<u32>(0xe4e6e9ebu, 0xd5d9dde1u, 0xc3c8cdd1u, 0xb1b5babfu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeef0f3f5u); }
        case 37u: { v = vec4<u32>(0xe4e7eaecu, 0xd6dadee1u, 0xc3c8cdd1u, 0xafb4b9beu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xf0f2f4f6u); }
        case 39u: { v = vec4<u32>(0xe5e8ebedu, 0xd6dadee2u, 0xc3c8cdd2u, 0xafb4b9beu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xf1f3f5f7u); }
        case 41u: { v = vec4<u32>(0xe6e9eceeu, 0xd7dbdfe3u, 0xc3c8cdd2u, 0xaeb3b9beu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf2f4f7f9u); }
        case 43u: { v = vec4<u32>(0xe7eaedf0u, 0xd8dce0e4u, 0xc4c9ced3u, 0xaeb4b9beu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f6f8f9u); }
        case 45u: { v = vec4<u32>(0xe8ebeef1u, 0xd9dde1e5u, 0xc5cacfd4u, 0xafb4babfu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu, 0xf5f7f9fau); }
        case 47u: { v = vec4<u32>(0xe9edeff2u, 0xdadee2e6u, 0xc6cbd0d5u, 0xafb5bbc0u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8f9fbu); }
        case 49u: { v = vec4<u32>(0xebeef1f3u, 0xdbe0e4e7u, 0xc7ccd2d7u, 0xb0b6bcc1u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 51u: { v = vec4<u32>(0xeceff2f4u, 0xdde1e5e9u, 0xc9ced3d8u, 0xb2b7bdc3u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf7f9fbfcu); }
        case 53u: { v = vec4<u32>(0xedf0f3f5u, 0xdee2e6eau, 0xcad0d5d9u, 0xb3b9bfc5u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf8fafbfcu); }
        case 55u: { v = vec4<u32>(0xeef1f4f6u, 0xdfe4e8ebu, 0xccd1d6dbu, 0xb5bbc1c7u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fafcfdu); }
        case 57u: { v = vec4<u32>(0xeff2f5f7u, 0xe1e5e9ecu, 0xced3d8ddu, 0xb8bdc3c9u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xf9fbfcfdu); }
        case 59u: { v = vec4<u32>(0xf0f3f6f8u, 0xe2e6eaedu, 0xd0d5dadeu, 0xbac0c5cbu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 61u: { v = vec4<u32>(0xf1f4f6f8u, 0xe4e8ebeeu, 0xd2d7dbe0u, 0xbdc3c8cdu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 63u: { v = vec4<u32>(0xf2f5f7f9u, 0xe5e9ecefu, 0xd4d8dde1u, 0xc0c5cacfu); }
        default: {}
      }
    }
    case 22u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfdfdfdfeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf7f4u, 0xfdfdfcfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfcfdfdu, 0xfbfbfbfcu, 0xf9fafafau, 0xf8f8f9f9u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0eau, 0xfbfafaf9u, 0xfbfbfbfbu); }
        case 7u: { v = vec4<u32>(0xfafafafbu, 0xf7f8f9f9u, 0xf5f5f6f7u, 0xf2f2f3f4u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf2eeeae6u, 0xf8f8f6f4u, 0xf9f9f9f9u); }
        case 9u: { v = vec4<u32>(0xf7f7f8f8u, 0xf4f4f5f6u, 0xf0f1f2f3u, 0xebecedeeu); }
        case 10u: { v = vec4<u32>(0xf1fcffffu, 0xedeae7e8u, 0xf6f4f3f0u, 0xf7f7f7f6u); }
        case 11u: { v = vec4<u32>(0xf4f5f6f6u, 0xf0f1f2f3u, 0xeaecedeeu, 0xe4e6e7e9u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e9eeu, 0xf3f1efedu, 0xf4f4f4f4u); }
        case 13u: { v = vec4<u32>(0xf1f2f3f4u, 0xecedeff0u, 0xe5e7e8eau, 0xdee0e1e3u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xe9e9edf4u, 0xf0efedebu, 0xf2f2f2f1u); }
        case 15u: { v = vec4<u32>(0xeef0f1f1u, 0xe8eaebedu, 0xe0e2e4e6u, 0xd7dadcdeu); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeaedf2f8u, 0xeeedebeau, 0xf0f0f0efu); }
        case 17u: { v = vec4<u32>(0xecedefefu, 0xe4e7e9eau, 0xdbdee0e2u, 0xd1d4d6d9u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xedf1f6fbu, 0xedecebebu, 0xeeeeeeeeu); }
        case 19u: { v = vec4<u32>(0xeaebedeeu, 0xe1e4e6e8u, 0xd7dadcdfu, 0xccced1d4u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf0f4f9fcu, 0xecececedu, 0xededededu); }
        case 21u: { v = vec4<u32>(0xe8eaebecu, 0xdee1e4e6u, 0xd3d6d9dcu, 0xc6cacdd0u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fbfdu, 0xecedeef0u, 0xececececu); }
        case 23u: { v = vec4<u32>(0xe6e8eaebu, 0xdcdfe2e4u, 0xcfd3d6d9u, 0xc2c5c8ccu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6fafcfeu, 0xedeef0f3u, 0xebecececu); }
        case 25u: { v = vec4<u32>(0xe5e7e9eau, 0xdadde0e3u, 0xccd0d3d7u, 0xbdc1c5c8u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeef0f2f5u, 0xebececedu); }
        case 27u: { v = vec4<u32>(0xe4e6e8e9u, 0xd8dcdfe1u, 0xc9cdd1d5u, 0xbabec2c5u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f7u, 0xebecedeeu); }
        case 29u: { v = vec4<u32>(0xe3e6e8e9u, 0xd7dadee1u, 0xc7cbcfd3u, 0xb6bbbfc3u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebedeef0u); }
        case 31u: { v = vec4<u32>(0xe3e5e8eau, 0xd6dadde0u, 0xc5caced2u, 0xb4b8bcc1u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f6f8fau, 0xeceef0f2u); }
        case 33u: { v = vec4<u32>(0xe3e6e8eau, 0xd5d9dde0u, 0xc4c8cdd1u, 0xb1b6babfu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f8fafbu, 0xedeff1f3u); }
        case 35u: { v = vec4<u32>(0xe3e6e8ebu, 0xd5d9dde0u, 0xc3c7ccd1u, 0xafb4b9beu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeef0f2f5u); }
        case 37u: { v = vec4<u32>(0xe4e7e9ecu, 0xd5d9dde0u, 0xc2c7ccd0u, 0xaeb3b8bdu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xeff1f4f6u); }
        case 39u: { v = vec4<u32>(0xe4e7eaedu, 0xd5d9dde1u, 0xc1c7ccd0u, 0xadb2b7bcu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xf0f3f5f7u); }
        case 41u: { v = vec4<u32>(0xe5e8ebeeu, 0xd5dadee2u, 0xc1c7ccd1u, 0xacb1b7bcu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf2f4f6f8u); }
        case 43u: { v = vec4<u32>(0xe6e9ecefu, 0xd6dbdfe3u, 0xc2c7ccd1u, 0xabb1b6bcu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f5f7f9u); }
        case 45u: { v = vec4<u32>(0xe7eaedf0u, 0xd7dbe0e4u, 0xc2c8cdd2u, 0xabb1b7bcu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf4f6f8fau); }
        case 47u: { v = vec4<u32>(0xe8ebeff1u, 0xd8dce1e5u, 0xc3c8ced3u, 0xacb1b7bdu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf5f7f9fbu); }
        case 49u: { v = vec4<u32>(0xe9edf0f2u, 0xd9dde2e6u, 0xc4c9cfd4u, 0xacb2b8beu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 51u: { v = vec4<u32>(0xeaeef1f3u, 0xdadfe3e7u, 0xc5cbd0d5u, 0xadb3b9bfu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf7f9fafcu); }
        case 53u: { v = vec4<u32>(0xebeff2f4u, 0xdbe0e4e8u, 0xc6ccd1d6u, 0xaeb4bac0u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf7f9fbfcu); }
        case 55u: { v = vec4<u32>(0xedf0f3f5u, 0xdce1e5e9u, 0xc8cdd3d8u, 0xb0b6bcc2u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf8fafbfcu); }
        case 57u: { v = vec4<u32>(0xeef1f4f6u, 0xdee2e6eau, 0xc9cfd4d9u, 0xb2b8bec4u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fafcfdu); }
        case 59u: { v = vec4<u32>(0xeff2f4f7u, 0xdfe3e8ebu, 0xcbd0d5dau, 0xb4bac0c5u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fbfcfdu); }
        case 61u: { v = vec4<u32>(0xf0f3f5f7u, 0xe0e5e9ecu, 0xcdd2d7dcu, 0xb6bcc2c7u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 63u: { v = vec4<u32>(0xf0f3f6f8u, 0xe1e6eaedu, 0xced3d8ddu, 0xb9bec4c9u); }
        default: {}
      }
    }
    case 23u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfdfdfdfeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf8f4u, 0xfdfdfdfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfcfdfdu, 0xfbfbfcfcu, 0xfafafafbu, 0xf8f8f9f9u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0eau, 0xfbfbfaf9u, 0xfbfbfbfbu); }
        case 7u: { v = vec4<u32>(0xfafafbfbu, 0xf8f8f9f9u, 0xf5f6f6f7u, 0xf2f3f4f4u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf2eeeae6u, 0xf9f8f6f5u, 0xf9f9f9f9u); }
        case 9u: { v = vec4<u32>(0xf7f8f8f9u, 0xf4f5f6f6u, 0xf0f1f2f3u, 0xecedeeefu); }
        case 10u: { v = vec4<u32>(0xf1fcffffu, 0xedeae7e8u, 0xf6f5f3f1u, 0xf7f7f7f6u); }
        case 11u: { v = vec4<u32>(0xf4f5f6f6u, 0xf0f1f2f3u, 0xebeceeefu, 0xe5e7e8e9u); }
        case 12u: { v = vec4<u32>(0xf7fdffffu, 0xeae8e9eeu, 0xf3f2f0edu, 0xf4f5f4f4u); }
        case 13u: { v = vec4<u32>(0xf2f3f3f4u, 0xeceeeff0u, 0xe6e7e9ebu, 0xdfe0e2e4u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xeaeaedf4u, 0xf0efedebu, 0xf2f2f2f2u); }
        case 15u: { v = vec4<u32>(0xeff0f1f2u, 0xe9eaecedu, 0xe1e3e5e7u, 0xd8dadcdfu); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xebedf2f8u, 0xeeedecebu, 0xf0f0f0efu); }
        case 17u: { v = vec4<u32>(0xeceeeff0u, 0xe5e7e9ebu, 0xdcdee1e3u, 0xd2d5d7d9u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xedf1f6fbu, 0xedecebecu, 0xeeefeeeeu); }
        case 19u: { v = vec4<u32>(0xeaecedeeu, 0xe2e4e6e8u, 0xd7dadddfu, 0xcccfd2d5u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf1f5f9fcu, 0xecececeeu, 0xededededu); }
        case 21u: { v = vec4<u32>(0xe8eaebecu, 0xdfe2e4e6u, 0xd3d6d9dcu, 0xc7cacdd0u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf4f7fbfdu, 0xededeef0u, 0xececececu); }
        case 23u: { v = vec4<u32>(0xe6e8eaebu, 0xdcdfe2e4u, 0xd0d3d6d9u, 0xc2c5c9ccu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6fafcfeu, 0xedeff0f3u, 0xebececedu); }
        case 25u: { v = vec4<u32>(0xe5e7e9eau, 0xdadde0e3u, 0xccd0d3d7u, 0xbec1c5c9u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xeff0f3f5u, 0xebececedu); }
        case 27u: { v = vec4<u32>(0xe4e6e8e9u, 0xd8dcdfe1u, 0xc9cdd1d5u, 0xb9bdc1c5u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f8u, 0xebecedefu); }
        case 29u: { v = vec4<u32>(0xe3e6e8e9u, 0xd7dadee1u, 0xc7cbcfd3u, 0xb6babec3u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebedeef0u); }
        case 31u: { v = vec4<u32>(0xe3e5e7e9u, 0xd6d9dde0u, 0xc5c9cdd2u, 0xb3b7bcc0u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f6f8fau, 0xeceeeff1u); }
        case 33u: { v = vec4<u32>(0xe3e5e8eau, 0xd5d9dce0u, 0xc3c8ccd0u, 0xb0b5b9beu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f7fafbu, 0xedeff1f3u); }
        case 35u: { v = vec4<u32>(0xe3e5e8eau, 0xd4d8dcdfu, 0xc2c6cbd0u, 0xaeb3b8bdu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xeef0f2f4u); }
        case 37u: { v = vec4<u32>(0xe3e6e9ebu, 0xd4d8dce0u, 0xc0c6cacfu, 0xacb1b6bbu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafbfdu, 0xeff1f3f6u); }
        case 39u: { v = vec4<u32>(0xe3e7e9ecu, 0xd4d8dce0u, 0xc0c5cacfu, 0xaab0b5bau); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xf0f2f5f7u); }
        case 41u: { v = vec4<u32>(0xe4e7eaedu, 0xd4d8dde1u, 0xbfc5cacfu, 0xa9afb4bau); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xf1f3f6f8u); }
        case 43u: { v = vec4<u32>(0xe5e8ebeeu, 0xd4d9dde1u, 0xbfc5cacfu, 0xa8aeb4b9u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf2f4f7f9u); }
        case 45u: { v = vec4<u32>(0xe6e9ecefu, 0xd5d9dee2u, 0xbfc5cad0u, 0xa8aeb3b9u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f5f8fau); }
        case 47u: { v = vec4<u32>(0xe7eaedf0u, 0xd5dadfe3u, 0xc0c5cbd0u, 0xa7aeb4bau); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfefeu, 0xf4f6f8fau); }
        case 49u: { v = vec4<u32>(0xe8ebeef1u, 0xd6dbe0e4u, 0xc0c6ccd1u, 0xa8aeb4bau); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf5f7f9fbu); }
        case 51u: { v = vec4<u32>(0xe9eceff2u, 0xd7dce1e5u, 0xc1c7ccd2u, 0xa8aeb5bbu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 53u: { v = vec4<u32>(0xeaedf0f3u, 0xd8dde2e6u, 0xc2c8cdd3u, 0xa9afb5bcu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf6f9fafcu); }
        case 55u: { v = vec4<u32>(0xebeef1f4u, 0xd9dee3e7u, 0xc3c9ced4u, 0xaab0b7bdu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf7f9fbfcu); }
        case 57u: { v = vec4<u32>(0xeceff2f5u, 0xdadfe4e8u, 0xc4cad0d5u, 0xabb2b8beu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf8fafbfcu); }
        case 59u: { v = vec4<u32>(0xedf0f3f6u, 0xdbe0e5e9u, 0xc5cbd1d6u, 0xadb3b9bfu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf8fafbfcu); }
        case 61u: { v = vec4<u32>(0xeef1f4f6u, 0xdce1e6eau, 0xc7cdd2d7u, 0xafb5bbc1u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf9fafcfdu); }
        case 63u: { v = vec4<u32>(0xeef2f4f7u, 0xdde2e7ebu, 0xc8ced3d8u, 0xb1b7bdc3u); }
        default: {}
      }
    }
    case 24u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfdfdfefeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf8f4u, 0xfdfdfdfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfdfdfdu, 0xfbfbfcfcu, 0xfafafbfbu, 0xf8f9f9f9u); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0ebu, 0xfbfbfaf9u, 0xfbfbfbfbu); }
        case 7u: { v = vec4<u32>(0xfafafbfbu, 0xf8f8f9fau, 0xf5f6f7f7u, 0xf3f3f4f5u); }
        case 8u: { v = vec4<u32>(0xe9f7feffu, 0xf2efeae6u, 0xf9f8f7f5u, 0xf9f9f9f9u); }
        case 9u: { v = vec4<u32>(0xf7f8f8f9u, 0xf4f5f6f7u, 0xf1f2f2f3u, 0xecedeef0u); }
        case 10u: { v = vec4<u32>(0xf1fcffffu, 0xeeeae8e9u, 0xf6f5f3f1u, 0xf7f7f7f7u); }
        case 11u: { v = vec4<u32>(0xf5f5f6f7u, 0xf0f2f3f4u, 0xebedeeefu, 0xe6e7e9eau); }
        case 12u: { v = vec4<u32>(0xf8fdffffu, 0xebe9e9efu, 0xf3f2f0edu, 0xf5f5f5f4u); }
        case 13u: { v = vec4<u32>(0xf2f3f4f4u, 0xedeeeff1u, 0xe6e8eaebu, 0xdfe1e3e5u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xeaeaeef4u, 0xf1efedebu, 0xf2f3f2f2u); }
        case 15u: { v = vec4<u32>(0xeff0f1f2u, 0xe9ebeceeu, 0xe1e3e5e7u, 0xd9dbdddfu); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xebeef2f8u, 0xefedecebu, 0xf0f1f0f0u); }
        case 17u: { v = vec4<u32>(0xedeeeff0u, 0xe5e8e9ebu, 0xdcdfe1e3u, 0xd3d5d8dau); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xeef1f6fbu, 0xededececu, 0xefefefeeu); }
        case 19u: { v = vec4<u32>(0xeaecedeeu, 0xe2e5e7e9u, 0xd8dbdde0u, 0xcdd0d2d5u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf1f5f9fcu, 0xedededeeu, 0xededededu); }
        case 21u: { v = vec4<u32>(0xe8eaebecu, 0xdfe2e4e6u, 0xd4d7dadcu, 0xc7cacdd1u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf4f8fbfdu, 0xededeff1u, 0xececededu); }
        case 23u: { v = vec4<u32>(0xe7e8eaebu, 0xdddfe2e4u, 0xd0d3d6dau, 0xc2c6c9ccu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf7fafcfeu, 0xeeeff1f3u, 0xebececedu); }
        case 25u: { v = vec4<u32>(0xe5e7e9eau, 0xdadde0e3u, 0xccd0d3d7u, 0xbdc1c5c9u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeff1f3f6u, 0xebecedeeu); }
        case 27u: { v = vec4<u32>(0xe4e6e8e9u, 0xd8dbdfe1u, 0xc9cdd1d5u, 0xb9bdc1c5u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f8u, 0xebecedefu); }
        case 29u: { v = vec4<u32>(0xe3e5e7e9u, 0xd6dadde0u, 0xc6cbcfd3u, 0xb5b9bec2u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebeceef0u); }
        case 31u: { v = vec4<u32>(0xe2e5e7e9u, 0xd5d9dcdfu, 0xc4c8cdd1u, 0xb2b6bbbfu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf4f6f8fau, 0xebedeff1u); }
        case 33u: { v = vec4<u32>(0xe2e5e7e9u, 0xd4d8dcdfu, 0xc2c7cbd0u, 0xafb3b8bdu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f7fafbu, 0xeceef0f3u); }
        case 35u: { v = vec4<u32>(0xe2e5e7eau, 0xd3d7dbdfu, 0xc0c5cacfu, 0xacb1b6bbu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f9fbfcu, 0xedeff2f4u); }
        case 37u: { v = vec4<u32>(0xe2e5e8ebu, 0xd2d7dbdfu, 0xbfc4c9ceu, 0xa9afb4b9u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafbfdu, 0xeef1f3f5u); }
        case 39u: { v = vec4<u32>(0xe2e6e9ebu, 0xd2d7dbdfu, 0xbec3c8cdu, 0xa8adb3b8u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fafcfdu, 0xeff2f4f6u); }
        case 41u: { v = vec4<u32>(0xe3e6e9ecu, 0xd2d7dbdfu, 0xbdc2c8cdu, 0xa6acb1b7u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xf0f3f5f7u); }
        case 43u: { v = vec4<u32>(0xe3e7eaedu, 0xd2d7dbe0u, 0xbcc2c8cdu, 0xa5abb0b6u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf1f4f6f8u); }
        case 45u: { v = vec4<u32>(0xe4e8ebeeu, 0xd2d7dce0u, 0xbcc2c8cdu, 0xa4aab0b6u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf2f5f7f9u); }
        case 47u: { v = vec4<u32>(0xe5e9ecefu, 0xd3d8dce1u, 0xbcc2c8cdu, 0xa3a9afb6u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf3f6f8fau); }
        case 49u: { v = vec4<u32>(0xe6e9edf0u, 0xd3d8dde2u, 0xbcc2c8ceu, 0xa3a9afb6u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf4f6f9fau); }
        case 51u: { v = vec4<u32>(0xe7eaeef1u, 0xd4d9dee2u, 0xbcc3c9ceu, 0xa3a9b0b6u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf5f7f9fbu); }
        case 53u: { v = vec4<u32>(0xe7ebeff2u, 0xd4dadfe3u, 0xbdc3c9cfu, 0xa3a9b0b6u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 55u: { v = vec4<u32>(0xe8ecf0f3u, 0xd5dbdfe4u, 0xbec4cad0u, 0xa3aab1b7u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf6f8fafcu); }
        case 57u: { v = vec4<u32>(0xe9edf1f4u, 0xd6dbe0e5u, 0xbec5cbd1u, 0xa4abb1b8u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf7f9fbfcu); }
        case 59u: { v = vec4<u32>(0xeaeef1f4u, 0xd7dce1e6u, 0xbfc6ccd1u, 0xa6acb3b9u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf7f9fbfcu); }
        case 61u: { v = vec4<u32>(0xebeff2f5u, 0xd8dde2e7u, 0xc0c7cdd2u, 0xa7adb4bau); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xf8fafbfcu); }
        case 63u: { v = vec4<u32>(0xecf0f3f6u, 0xd9dee3e8u, 0xc2c8ced3u, 0xa9afb5bbu); }
        default: {}
      }
    }
    case 25u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfdfefefeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xede4f6ffu, 0xfbfaf8f4u, 0xfdfdfdfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfdfdfdu, 0xfbfcfcfcu, 0xfafafbfbu, 0xf9f9f9fau); }
        case 6u: { v = vec4<u32>(0xe5ecfdffu, 0xf7f4f0ebu, 0xfbfbfaf9u, 0xfbfbfcfbu); }
        case 7u: { v = vec4<u32>(0xfafbfbfbu, 0xf8f9f9fau, 0xf6f6f7f8u, 0xf3f4f4f5u); }
        case 8u: { v = vec4<u32>(0xe9f7ffffu, 0xf2efeae7u, 0xf9f8f7f5u, 0xf9f9f9f9u); }
        case 9u: { v = vec4<u32>(0xf8f8f9f9u, 0xf5f5f6f7u, 0xf1f2f3f4u, 0xedeeeff0u); }
        case 10u: { v = vec4<u32>(0xf2fcffffu, 0xeeebe8e9u, 0xf6f5f3f1u, 0xf7f7f7f7u); }
        case 11u: { v = vec4<u32>(0xf5f6f6f7u, 0xf1f2f3f4u, 0xecedeef0u, 0xe6e8e9ebu); }
        case 12u: { v = vec4<u32>(0xf8feffffu, 0xebe9eaefu, 0xf4f2f0eeu, 0xf5f5f5f4u); }
        case 13u: { v = vec4<u32>(0xf2f3f4f4u, 0xedeff0f1u, 0xe7e8eaecu, 0xe0e2e3e5u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xebebeef5u, 0xf1f0eeecu, 0xf3f3f3f2u); }
        case 15u: { v = vec4<u32>(0xeff1f2f2u, 0xe9ebedeeu, 0xe2e4e6e8u, 0xd9dcdee0u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeceef3f9u, 0xefeeedecu, 0xf1f1f1f0u); }
        case 17u: { v = vec4<u32>(0xedeeeff0u, 0xe6e8eaebu, 0xdddfe2e4u, 0xd3d6d8dbu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xeef2f7fbu, 0xeeedecedu, 0xefefefefu); }
        case 19u: { v = vec4<u32>(0xebecedeeu, 0xe3e5e7e9u, 0xd8dbdee0u, 0xcdd0d3d6u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf1f5f9fdu, 0xedededefu, 0xedeeeeedu); }
        case 21u: { v = vec4<u32>(0xe8eaecedu, 0xdfe2e4e7u, 0xd4d7daddu, 0xc7cbced1u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf4f8fbfdu, 0xedeeeff1u, 0xecedededu); }
        case 23u: { v = vec4<u32>(0xe7e8eaebu, 0xdddfe2e4u, 0xd0d3d6dau, 0xc2c6c9ccu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf7fafcfeu, 0xeeeff1f4u, 0xebecededu); }
        case 25u: { v = vec4<u32>(0xe5e7e9eau, 0xdadde0e3u, 0xccd0d3d7u, 0xbdc1c5c8u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeff1f3f6u, 0xebecedeeu); }
        case 27u: { v = vec4<u32>(0xe4e6e8e9u, 0xd8dbdee1u, 0xc9cdd1d4u, 0xb8bdc1c5u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f3f5f8u, 0xeaecedefu); }
        case 29u: { v = vec4<u32>(0xe3e5e7e9u, 0xd6d9dde0u, 0xc6caced2u, 0xb4b9bdc1u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xebeceef0u); }
        case 31u: { v = vec4<u32>(0xe2e4e7e9u, 0xd4d8dcdfu, 0xc3c7ccd0u, 0xb0b5babeu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf3f6f8fau, 0xebedeff1u); }
        case 33u: { v = vec4<u32>(0xe1e4e7e9u, 0xd3d7dbdeu, 0xc1c5cacfu, 0xadb2b7bcu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f7f9fbu, 0xeceef0f2u); }
        case 35u: { v = vec4<u32>(0xe1e4e7e9u, 0xd2d6dadeu, 0xbec4c8cdu, 0xaaafb4b9u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xeceff1f4u); }
        case 37u: { v = vec4<u32>(0xe1e4e7eau, 0xd1d5daddu, 0xbdc2c7ccu, 0xa7acb2b7u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xedf0f2f5u); }
        case 39u: { v = vec4<u32>(0xe1e4e7eau, 0xd0d5d9ddu, 0xbbc1c6cbu, 0xa4aab0b6u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xeef1f3f6u); }
        case 41u: { v = vec4<u32>(0xe1e5e8ebu, 0xd0d5d9ddu, 0xbac0c5cbu, 0xa2a8aeb4u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xeff2f5f7u); }
        case 43u: { v = vec4<u32>(0xe2e5e9ecu, 0xd0d5d9deu, 0xb9bfc5cau, 0xa1a7adb3u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xf0f3f5f8u); }
        case 45u: { v = vec4<u32>(0xe2e6eaedu, 0xcfd5d9deu, 0xb8bec4cau, 0x9fa5acb2u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf1f4f6f9u); }
        case 47u: { v = vec4<u32>(0xe3e7eaeeu, 0xd0d5dadeu, 0xb8bec4cau, 0x9ea4abb1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf2f5f7f9u); }
        case 49u: { v = vec4<u32>(0xe3e7ebefu, 0xd0d5dadfu, 0xb7bec4cau, 0x9da4aab1u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf3f5f8fau); }
        case 51u: { v = vec4<u32>(0xe4e8ecf0u, 0xd0d6dbe0u, 0xb7bec4cau, 0x9da3aab1u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf4f6f8fau); }
        case 53u: { v = vec4<u32>(0xe5e9edf0u, 0xd0d6dbe0u, 0xb7bec4cbu, 0x9ca3aab1u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf4f7f9fbu); }
        case 55u: { v = vec4<u32>(0xe6eaeef1u, 0xd1d7dce1u, 0xb8bec5cbu, 0x9ca3aab1u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf5f8fafbu); }
        case 57u: { v = vec4<u32>(0xe7ebeff2u, 0xd2d7dde2u, 0xb8bfc5cbu, 0x9da3aab1u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf6f8fafbu); }
        case 59u: { v = vec4<u32>(0xe8ecf0f3u, 0xd2d8dee3u, 0xb8bfc6ccu, 0x9da4abb2u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf6f9fafcu); }
        case 61u: { v = vec4<u32>(0xe8edf0f4u, 0xd3d9dfe4u, 0xb9c0c6cdu, 0x9ea5acb2u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf7f9fbfcu); }
        case 63u: { v = vec4<u32>(0xe9eef1f4u, 0xd4dadfe5u, 0xbac1c7ceu, 0xa0a6adb3u); }
        default: {}
      }
    }
    case 26u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xfaf3e4ffu, 0xfefefdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfdfefefeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xede5f6ffu, 0xfbfaf8f4u, 0xfdfdfdfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfdfdfdu, 0xfbfcfcfcu, 0xfafbfbfbu, 0xf9f9fafau); }
        case 6u: { v = vec4<u32>(0xe6edfdffu, 0xf7f5f1ebu, 0xfbfbfaf9u, 0xfbfcfcfcu); }
        case 7u: { v = vec4<u32>(0xfafbfbfbu, 0xf8f9f9fau, 0xf6f7f7f8u, 0xf3f4f5f5u); }
        case 8u: { v = vec4<u32>(0xeaf7ffffu, 0xf3efebe7u, 0xf9f8f7f5u, 0xf9fafaf9u); }
        case 9u: { v = vec4<u32>(0xf8f8f9f9u, 0xf5f6f6f7u, 0xf1f2f3f4u, 0xedeeeff0u); }
        case 10u: { v = vec4<u32>(0xf2fcffffu, 0xefebe9eau, 0xf6f5f4f2u, 0xf7f7f7f7u); }
        case 11u: { v = vec4<u32>(0xf5f6f6f7u, 0xf1f2f3f4u, 0xeceeeff0u, 0xe7e8eaebu); }
        case 12u: { v = vec4<u32>(0xf8feffffu, 0xeceaebf0u, 0xf4f3f1eeu, 0xf5f5f5f5u); }
        case 13u: { v = vec4<u32>(0xf2f3f4f5u, 0xedeff0f1u, 0xe7e9eaecu, 0xe0e2e4e6u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xebeceff5u, 0xf2f0eeedu, 0xf3f3f3f2u); }
        case 15u: { v = vec4<u32>(0xf0f1f2f2u, 0xeaebedeeu, 0xe2e4e6e8u, 0xdadcdee0u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xedeff3f9u, 0xf0eeedecu, 0xf1f1f1f0u); }
        case 17u: { v = vec4<u32>(0xedeef0f0u, 0xe6e8eaecu, 0xdde0e2e4u, 0xd3d6d8dbu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xeff2f7fbu, 0xeeeeededu, 0xefefefefu); }
        case 19u: { v = vec4<u32>(0xebecedeeu, 0xe3e5e7e9u, 0xd8dbdee0u, 0xcdd0d3d6u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf2f6fafdu, 0xeeeeeeefu, 0xedeeeeeeu); }
        case 21u: { v = vec4<u32>(0xe9eaecedu, 0xdfe2e4e7u, 0xd4d7daddu, 0xc7cbced1u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf5f8fbfdu, 0xeeeeeff2u, 0xecedededu); }
        case 23u: { v = vec4<u32>(0xe7e8eaebu, 0xdcdfe2e4u, 0xd0d3d6d9u, 0xc2c5c9ccu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf7fafcfeu, 0xeeeff1f4u, 0xebecededu); }
        case 25u: { v = vec4<u32>(0xe5e7e9eau, 0xdadde0e2u, 0xcccfd3d6u, 0xbcc0c4c8u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeff1f3f6u, 0xeaecedeeu); }
        case 27u: { v = vec4<u32>(0xe3e6e7e9u, 0xd7dbdee1u, 0xc8ccd0d4u, 0xb7bcc0c4u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xf0f3f5f8u, 0xeaecedefu); }
        case 29u: { v = vec4<u32>(0xe2e5e7e9u, 0xd5d9dcdfu, 0xc5c9cdd1u, 0xb3b7bcc0u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf2f4f7f9u, 0xeaeceef0u); }
        case 31u: { v = vec4<u32>(0xe1e4e6e8u, 0xd3d7dbdeu, 0xc2c6cbcfu, 0xafb3b8bdu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf3f6f8fau, 0xeaeceff1u); }
        case 33u: { v = vec4<u32>(0xe0e3e6e8u, 0xd2d6daddu, 0xbfc4c9cdu, 0xabb0b5bau); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f7f9fbu, 0xebedf0f2u); }
        case 35u: { v = vec4<u32>(0xe0e3e6e8u, 0xd0d4d9dcu, 0xbcc2c7cbu, 0xa7acb2b7u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f8fafcu, 0xebeef1f3u); }
        case 37u: { v = vec4<u32>(0xdfe3e6e9u, 0xcfd4d8dcu, 0xbac0c5cau, 0xa4aaafb5u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfcu, 0xeceff2f4u); }
        case 39u: { v = vec4<u32>(0xdfe3e6e9u, 0xced3d7dbu, 0xb8bec4c9u, 0xa1a7adb3u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xedf0f3f5u); }
        case 41u: { v = vec4<u32>(0xdfe3e6eau, 0xcdd2d7dbu, 0xb7bdc2c8u, 0x9ea4abb1u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeef1f4f6u); }
        case 43u: { v = vec4<u32>(0xdfe3e7eau, 0xcdd2d7dbu, 0xb5bbc1c7u, 0x9ca2a9afu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xeff2f5f7u); }
        case 45u: { v = vec4<u32>(0xe0e4e8ebu, 0xccd1d7dbu, 0xb4bac0c6u, 0x9aa1a7aeu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf0f3f5f8u); }
        case 47u: { v = vec4<u32>(0xe0e4e8ecu, 0xccd1d7dcu, 0xb3bac0c6u, 0x989fa6acu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf0f4f6f9u); }
        case 49u: { v = vec4<u32>(0xe1e5e9edu, 0xccd1d7dcu, 0xb2b9bfc6u, 0x979ea5abu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf1f4f7f9u); }
        case 51u: { v = vec4<u32>(0xe1e6eaeeu, 0xccd2d7dcu, 0xb2b8bfc5u, 0x969da4abu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf2f5f8fau); }
        case 53u: { v = vec4<u32>(0xe2e7ebefu, 0xccd2d7ddu, 0xb1b8bfc5u, 0x959ca3aau); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf3f6f8fau); }
        case 55u: { v = vec4<u32>(0xe3e7ecf0u, 0xccd2d8deu, 0xb1b8bfc5u, 0x949ca3aau); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf4f7f9fbu); }
        case 57u: { v = vec4<u32>(0xe4e8edf0u, 0xccd3d9deu, 0xb1b8bfc6u, 0x949ba2aau); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf4f7f9fbu); }
        case 59u: { v = vec4<u32>(0xe4e9eef1u, 0xcdd3d9dfu, 0xb1b8bfc6u, 0x949ba2aau); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf5f8fafbu); }
        case 61u: { v = vec4<u32>(0xe5eaeef2u, 0xcdd4dae0u, 0xb1b8c0c7u, 0x959ca3aau); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf6f8fafcu); }
        case 63u: { v = vec4<u32>(0xe6ebeff3u, 0xced5dbe1u, 0xb2b9c0c7u, 0x969ca3abu); }
        default: {}
      }
    }
    case 27u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xfaf3e4ffu, 0xfefefdfcu, 0xfffefefeu, 0xfefeffffu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfefefefeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xede5f6ffu, 0xfbfaf8f4u, 0xfdfdfdfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfdfdfdfdu, 0xfcfcfcfcu, 0xfafbfbfbu, 0xf9f9fafau); }
        case 6u: { v = vec4<u32>(0xe6edfdffu, 0xf8f5f1ebu, 0xfbfbfaf9u, 0xfcfcfcfcu); }
        case 7u: { v = vec4<u32>(0xfafbfbfbu, 0xf9f9fafau, 0xf6f7f7f8u, 0xf4f4f5f6u); }
        case 8u: { v = vec4<u32>(0xeaf7ffffu, 0xf3f0ebe8u, 0xf9f8f7f6u, 0xfafafafau); }
        case 9u: { v = vec4<u32>(0xf8f8f9f9u, 0xf5f6f7f7u, 0xf2f3f3f4u, 0xeeeff0f1u); }
        case 10u: { v = vec4<u32>(0xf2fcffffu, 0xefece9ebu, 0xf7f6f4f2u, 0xf7f8f8f7u); }
        case 11u: { v = vec4<u32>(0xf5f6f7f7u, 0xf1f3f4f4u, 0xedeeeff0u, 0xe7e9eaebu); }
        case 12u: { v = vec4<u32>(0xf8feffffu, 0xedebebf0u, 0xf4f3f1efu, 0xf5f5f5f5u); }
        case 13u: { v = vec4<u32>(0xf3f3f4f5u, 0xeeeff0f1u, 0xe8e9ebecu, 0xe1e2e4e6u); }
        case 14u: { v = vec4<u32>(0xfbfeffffu, 0xecedf0f6u, 0xf2f1efeeu, 0xf3f3f3f3u); }
        case 15u: { v = vec4<u32>(0xf0f1f2f3u, 0xeaecedefu, 0xe2e4e6e8u, 0xdadcdee0u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xedf0f4f9u, 0xf0efeeedu, 0xf1f1f1f1u); }
        case 17u: { v = vec4<u32>(0xedeff0f0u, 0xe6e8eaecu, 0xdde0e2e4u, 0xd4d6d9dbu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf0f3f7fbu, 0xefeeeeeeu, 0xefeff0efu); }
        case 19u: { v = vec4<u32>(0xebecedeeu, 0xe3e5e7e9u, 0xd9dbdee0u, 0xcdd0d3d6u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf2f6fafdu, 0xeeeeeff0u, 0xedeeeeeeu); }
        case 21u: { v = vec4<u32>(0xe8eaecedu, 0xdfe2e4e6u, 0xd4d7daddu, 0xc7caced1u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf5f8fbfeu, 0xeeeff0f2u, 0xecededeeu); }
        case 23u: { v = vec4<u32>(0xe6e8eaebu, 0xdcdfe2e4u, 0xcfd3d6d9u, 0xc1c5c8ccu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xeef0f2f4u, 0xebecededu); }
        case 25u: { v = vec4<u32>(0xe4e6e8eau, 0xd9dcdfe2u, 0xcbcfd2d6u, 0xbcbfc3c7u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeff1f3f6u, 0xeaebedeeu); }
        case 27u: { v = vec4<u32>(0xe3e5e7e9u, 0xd7dadde0u, 0xc7cbcfd3u, 0xb6bbbfc3u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f8u, 0xeaebedeeu); }
        case 29u: { v = vec4<u32>(0xe1e4e6e8u, 0xd4d8dbdeu, 0xc3c8ccd0u, 0xb1b6babfu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf1f4f7f9u, 0xe9ebedefu); }
        case 31u: { v = vec4<u32>(0xe0e3e5e7u, 0xd2d6d9ddu, 0xc0c5c9ceu, 0xadb1b6bbu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf3f5f8fau, 0xe9eceef0u); }
        case 33u: { v = vec4<u32>(0xdfe2e5e7u, 0xd0d4d8dcu, 0xbdc2c7cbu, 0xa8adb3b8u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f6f9fbu, 0xeaeceff1u); }
        case 35u: { v = vec4<u32>(0xdee1e4e7u, 0xced3d7dbu, 0xbabfc4c9u, 0xa4aaafb5u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xeaedf0f2u); }
        case 37u: { v = vec4<u32>(0xdde1e4e7u, 0xccd1d6dau, 0xb7bdc2c7u, 0xa0a6acb2u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f9fbfcu, 0xebeef1f3u); }
        case 39u: { v = vec4<u32>(0xdde1e4e7u, 0xcbd0d5d9u, 0xb5bbc0c6u, 0x9da3a9afu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xebeef2f4u); }
        case 41u: { v = vec4<u32>(0xdde1e4e8u, 0xcacfd4d9u, 0xb3b9bfc4u, 0x9aa0a6adu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xeceff3f5u); }
        case 43u: { v = vec4<u32>(0xdde1e5e9u, 0xc9ced3d8u, 0xb1b7bdc3u, 0x979da4aau); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xedf0f3f6u); }
        case 45u: { v = vec4<u32>(0xdde1e5e9u, 0xc8ced3d8u, 0xafb6bcc2u, 0x959ba2a8u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfdu, 0xeef1f4f7u); }
        case 47u: { v = vec4<u32>(0xdde2e6eau, 0xc7cdd3d8u, 0xaeb4bbc1u, 0x9299a0a7u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeff2f5f8u); }
        case 49u: { v = vec4<u32>(0xdde2e7ebu, 0xc7cdd3d8u, 0xacb3bac1u, 0x90979ea5u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf0f3f6f8u); }
        case 51u: { v = vec4<u32>(0xdee3e8ecu, 0xc7cdd3d9u, 0xabb2b9c0u, 0x8e969da4u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf1f4f7f9u); }
        case 53u: { v = vec4<u32>(0xdee4e8edu, 0xc6cdd3d9u, 0xaab1b9c0u, 0x8d949ba3u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf1f5f7fau); }
        case 55u: { v = vec4<u32>(0xdfe4e9eeu, 0xc6cdd3d9u, 0xa9b1b8bfu, 0x8c939aa2u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf2f5f8fau); }
        case 57u: { v = vec4<u32>(0xe0e5eaeeu, 0xc6cdd4dau, 0xa9b0b8bfu, 0x8b929aa1u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf3f6f8fau); }
        case 59u: { v = vec4<u32>(0xe1e6ebefu, 0xc7ced4dbu, 0xa8b0b8bfu, 0x8a9299a1u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf4f7f9fbu); }
        case 61u: { v = vec4<u32>(0xe2e7ecf0u, 0xc7ced5dcu, 0xa8b0b8bfu, 0x8a9199a0u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf4f7f9fbu); }
        case 63u: { v = vec4<u32>(0xe3e8edf1u, 0xc8cfd6ddu, 0xa8b0b8c0u, 0x8a9299a1u); }
        default: {}
      }
    }
    case 28u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xfaf3e4ffu, 0xfefefdfcu, 0xfffefefeu, 0xfeffffffu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfefefefeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xeee5f6ffu, 0xfcfaf8f4u, 0xfdfdfdfcu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfdfdfdfdu, 0xfcfcfcfcu, 0xfafbfbfbu, 0xf9f9fafau); }
        case 6u: { v = vec4<u32>(0xe7edfdffu, 0xf8f5f2ecu, 0xfcfbfbfau, 0xfcfcfcfcu); }
        case 7u: { v = vec4<u32>(0xfafbfbfbu, 0xf9f9fafau, 0xf6f7f8f8u, 0xf4f5f5f6u); }
        case 8u: { v = vec4<u32>(0xebf8ffffu, 0xf4f1ece9u, 0xf9f9f8f6u, 0xfafafafau); }
        case 9u: { v = vec4<u32>(0xf8f9f9f9u, 0xf5f6f7f7u, 0xf2f3f4f4u, 0xeeeff0f1u); }
        case 10u: { v = vec4<u32>(0xf3fcffffu, 0xf0edebecu, 0xf7f6f5f3u, 0xf8f8f8f8u); }
        case 11u: { v = vec4<u32>(0xf5f6f7f7u, 0xf2f3f4f5u, 0xedeeeff1u, 0xe8e9eaecu); }
        case 12u: { v = vec4<u32>(0xf9feffffu, 0xeeecedf1u, 0xf5f4f2f0u, 0xf5f6f6f5u); }
        case 13u: { v = vec4<u32>(0xf3f4f4f5u, 0xeeeff0f2u, 0xe8e9ebecu, 0xe1e3e4e6u); }
        case 14u: { v = vec4<u32>(0xfcfeffffu, 0xedeef1f6u, 0xf2f1f0efu, 0xf3f3f3f3u); }
        case 15u: { v = vec4<u32>(0xf0f1f2f3u, 0xeaecedefu, 0xe3e5e6e8u, 0xdadcdee1u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeff1f5fau, 0xf1f0efeeu, 0xf1f1f1f1u); }
        case 17u: { v = vec4<u32>(0xedeef0f0u, 0xe6e8eaecu, 0xdde0e2e4u, 0xd4d6d9dbu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf1f4f8fcu, 0xefefefefu, 0xeff0f0f0u); }
        case 19u: { v = vec4<u32>(0xebecedeeu, 0xe2e5e7e9u, 0xd8dbdee0u, 0xcdd0d3d6u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf3f6fafdu, 0xeeefeff1u, 0xedeeeeeeu); }
        case 21u: { v = vec4<u32>(0xe8eaebecu, 0xdfe1e4e6u, 0xd3d6d9dcu, 0xc7cacdd0u); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xeeeff0f2u, 0xecededeeu); }
        case 23u: { v = vec4<u32>(0xe6e8e9ebu, 0xdcdee1e3u, 0xcfd2d5d8u, 0xc0c4c8cbu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xeef0f2f4u, 0xeaececedu); }
        case 25u: { v = vec4<u32>(0xe4e6e8e9u, 0xd8dbdee1u, 0xcaced1d5u, 0xbabec2c6u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeff1f3f6u, 0xe9ebecedu); }
        case 27u: { v = vec4<u32>(0xe2e4e6e8u, 0xd5d9dcdfu, 0xc6caced2u, 0xb5b9bdc2u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xf0f2f5f8u, 0xe9eaeceeu); }
        case 29u: { v = vec4<u32>(0xe0e2e5e7u, 0xd2d6daddu, 0xc2c6cacfu, 0xafb4b8bdu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf1f3f6f9u, 0xe8eaeceeu); }
        case 31u: { v = vec4<u32>(0xdee1e4e6u, 0xd0d4d8dbu, 0xbec3c7ccu, 0xaaafb4b9u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf2f5f7fau, 0xe8eaedefu); }
        case 33u: { v = vec4<u32>(0xdde0e3e5u, 0xcdd2d6dau, 0xbabfc4c9u, 0xa5aab0b5u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf3f6f8fbu, 0xe8ebedf0u); }
        case 35u: { v = vec4<u32>(0xdcdfe2e5u, 0xcbd0d4d8u, 0xb7bcc1c6u, 0xa1a6acb1u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f7f9fbu, 0xe8ebeef1u); }
        case 37u: { v = vec4<u32>(0xdbdee2e5u, 0xc9ced3d7u, 0xb4b9bfc4u, 0x9ca2a8aeu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xe9eceff2u); }
        case 39u: { v = vec4<u32>(0xdadee2e5u, 0xc8cdd1d6u, 0xb1b7bdc2u, 0x989ea5abu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfcu, 0xe9edf0f3u); }
        case 41u: { v = vec4<u32>(0xdadee2e6u, 0xc6cbd0d5u, 0xaeb4bac0u, 0x959ba1a8u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xeaeef1f4u); }
        case 43u: { v = vec4<u32>(0xd9dee2e6u, 0xc4cacfd4u, 0xacb2b8bfu, 0x91989ea5u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xebeff2f5u); }
        case 45u: { v = vec4<u32>(0xd9dee2e7u, 0xc3c9cfd4u, 0xa9b0b7bdu, 0x8e959ca3u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeceff3f6u); }
        case 47u: { v = vec4<u32>(0xd9dee3e7u, 0xc2c8ced4u, 0xa7aeb5bcu, 0x8b9299a0u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfdu, 0xedf0f4f7u); }
        case 49u: { v = vec4<u32>(0xd9dfe4e8u, 0xc1c8ced4u, 0xa5adb4bbu, 0x8990979eu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeef1f5f8u); }
        case 51u: { v = vec4<u32>(0xdadfe4e9u, 0xc1c7ced4u, 0xa4abb2bau, 0x868d959cu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeff2f6f8u); }
        case 53u: { v = vec4<u32>(0xdae0e5eau, 0xc0c7ced4u, 0xa2aab1b9u, 0x848b939bu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xeff3f6f9u); }
        case 55u: { v = vec4<u32>(0xdbe1e6ebu, 0xc0c7ced5u, 0xa1a9b1b8u, 0x828a9199u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf0f4f7f9u); }
        case 57u: { v = vec4<u32>(0xdce2e7ecu, 0xc0c7ced5u, 0xa0a8b0b8u, 0x81889098u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf1f5f7fau); }
        case 59u: { v = vec4<u32>(0xdde3e8edu, 0xc0c7cfd6u, 0x9fa7afb7u, 0x7f878f97u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf2f5f8fau); }
        case 61u: { v = vec4<u32>(0xdee4e9eeu, 0xc0c8d0d7u, 0x9ea6afb7u, 0x7e868e96u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf3f6f8fau); }
        case 63u: { v = vec4<u32>(0xdfe5eaefu, 0xc0c9d1d8u, 0x9ea6afb8u, 0x7e858d95u); }
        default: {}
      }
    }
    case 29u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xfaf4e4ffu, 0xfefefdfcu, 0xfffffefeu, 0xfeffffffu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfefefefeu, 0xfdfdfdfeu); }
        case 4u: { v = vec4<u32>(0xeee6f7ffu, 0xfcfbf9f5u, 0xfdfdfdfdu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfdfdfdfdu, 0xfcfcfcfcu, 0xfbfbfbfbu, 0xf9fafafau); }
        case 6u: { v = vec4<u32>(0xe8eefdffu, 0xf8f6f3edu, 0xfcfbfbfau, 0xfcfcfcfcu); }
        case 7u: { v = vec4<u32>(0xfbfbfbfbu, 0xf9f9fafau, 0xf7f7f8f8u, 0xf4f5f5f6u); }
        case 8u: { v = vec4<u32>(0xedf8ffffu, 0xf5f2eeebu, 0xfaf9f8f7u, 0xfafafafau); }
        case 9u: { v = vec4<u32>(0xf8f9f9f9u, 0xf5f6f7f7u, 0xf2f3f4f5u, 0xeeeff0f1u); }
        case 10u: { v = vec4<u32>(0xf4fcffffu, 0xf1efededu, 0xf7f7f5f4u, 0xf8f8f8f8u); }
        case 11u: { v = vec4<u32>(0xf5f6f7f7u, 0xf2f3f4f5u, 0xedeeeff1u, 0xe8e9eaecu); }
        case 12u: { v = vec4<u32>(0xf9feffffu, 0xefeeeff3u, 0xf5f4f3f1u, 0xf5f6f6f6u); }
        case 13u: { v = vec4<u32>(0xf3f3f4f5u, 0xeeeff0f1u, 0xe8e9ebecu, 0xe1e3e4e6u); }
        case 14u: { v = vec4<u32>(0xfcfeffffu, 0xefeff2f7u, 0xf3f2f1f0u, 0xf3f3f4f3u); }
        case 15u: { v = vec4<u32>(0xf0f1f2f3u, 0xeaebedeeu, 0xe2e4e6e8u, 0xdadcdee0u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xf0f2f6fau, 0xf1f0f0efu, 0xf1f1f1f1u); }
        case 17u: { v = vec4<u32>(0xedeeeff0u, 0xe6e8eaebu, 0xdddfe2e4u, 0xd3d6d8dbu); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf1f4f8fcu, 0xefefeff0u, 0xefeff0f0u); }
        case 19u: { v = vec4<u32>(0xeaebedeeu, 0xe2e4e6e8u, 0xd8dadde0u, 0xcccfd2d5u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf3f7fafdu, 0xeeefeff1u, 0xededeeeeu); }
        case 21u: { v = vec4<u32>(0xe7e9eaecu, 0xdee1e3e5u, 0xd2d6d8dbu, 0xc6c9cccfu); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xeeeff0f2u, 0xebececedu); }
        case 23u: { v = vec4<u32>(0xe5e7e8eau, 0xdadde0e2u, 0xcdd1d4d7u, 0xbfc3c6cau); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xeeeff1f4u, 0xe9eaebecu); }
        case 25u: { v = vec4<u32>(0xe2e4e6e8u, 0xd7dadde0u, 0xc8ccd0d3u, 0xb9bdc1c5u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xeef0f2f5u, 0xe8e9ebecu); }
        case 27u: { v = vec4<u32>(0xe0e2e4e6u, 0xd3d7daddu, 0xc4c8ccd0u, 0xb2b7bbbfu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xeef1f4f7u, 0xe7e9eaecu); }
        case 29u: { v = vec4<u32>(0xdee0e3e5u, 0xd0d4d7dbu, 0xbfc4c8ccu, 0xacb1b6bbu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xeff2f5f8u, 0xe6e8eaedu); }
        case 31u: { v = vec4<u32>(0xdcdfe1e4u, 0xcdd1d5d8u, 0xbbc0c4c9u, 0xa7acb1b6u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xf0f3f6f9u, 0xe5e8ebedu); }
        case 33u: { v = vec4<u32>(0xdadde0e3u, 0xcacfd3d6u, 0xb7bcc1c6u, 0xa1a7acb1u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf1f5f8fau, 0xe5e8ebeeu); }
        case 35u: { v = vec4<u32>(0xd8dcdfe2u, 0xc8ccd1d5u, 0xb3b8bec3u, 0x9ca2a8adu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf3f6f9fbu, 0xe5e9ecefu); }
        case 37u: { v = vec4<u32>(0xd7dbdfe2u, 0xc5cacfd3u, 0xafb5bac0u, 0x979da3a9u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7f9fbu, 0xe6e9edf0u); }
        case 39u: { v = vec4<u32>(0xd6dadee2u, 0xc3c8cdd2u, 0xacb2b8bdu, 0x93999fa5u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xe6eaeef1u); }
        case 41u: { v = vec4<u32>(0xd5dadee2u, 0xc1c6ccd1u, 0xa8afb5bbu, 0x8f959ba2u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfcu, 0xe7ebeff3u); }
        case 43u: { v = vec4<u32>(0xd5dadee3u, 0xbfc5cad0u, 0xa5acb2b9u, 0x8b91989fu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xe8ecf0f4u); }
        case 45u: { v = vec4<u32>(0xd4dadfe3u, 0xbdc3c9cfu, 0xa3a9b0b7u, 0x878e959cu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe9edf1f5u); }
        case 47u: { v = vec4<u32>(0xd4dadfe4u, 0xbcc2c9cfu, 0xa0a7aeb5u, 0x838a9199u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xeaeef2f6u); }
        case 49u: { v = vec4<u32>(0xd4dae0e5u, 0xbbc1c8ceu, 0x9da5acb3u, 0x80878e96u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xebeff3f6u); }
        case 51u: { v = vec4<u32>(0xd5dbe1e6u, 0xb9c1c8ceu, 0x9ba3abb2u, 0x7d848c93u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xecf0f4f7u); }
        case 53u: { v = vec4<u32>(0xd5dce2e7u, 0xb9c0c8cfu, 0x99a1a9b1u, 0x7a818991u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xedf1f5f8u); }
        case 55u: { v = vec4<u32>(0xd6dde3e8u, 0xb8c0c8cfu, 0x979fa8b0u, 0x777f878fu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeef2f6f8u); }
        case 57u: { v = vec4<u32>(0xd7dee4e9u, 0xb8c0c8d0u, 0x959ea7afu, 0x757d858du); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xeff3f6f9u); }
        case 59u: { v = vec4<u32>(0xd8dfe5eau, 0xb7c0c8d0u, 0x949da6afu, 0x737b838bu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf0f4f7f9u); }
        case 61u: { v = vec4<u32>(0xd9e0e6ecu, 0xb7c0c9d1u, 0x939ca5aeu, 0x7179818au); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf1f5f8fau); }
        case 63u: { v = vec4<u32>(0xdae1e7edu, 0xb8c1cad2u, 0x929ba5aeu, 0x70788089u); }
        default: {}
      }
    }
    case 30u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfffefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xfaf4e5ffu, 0xfefefdfcu, 0xfffffefeu, 0xfeffffffu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfefefefeu, 0xfdfdfdfeu); }
        case 4u: { v = vec4<u32>(0xf0e8f7ffu, 0xfcfbf9f6u, 0xfdfdfdfdu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfdfdfdfdu, 0xfcfcfcfcu, 0xfbfbfbfbu, 0xf9fafafau); }
        case 6u: { v = vec4<u32>(0xebf0feffu, 0xf9f7f4f0u, 0xfcfbfbfau, 0xfcfcfcfcu); }
        case 7u: { v = vec4<u32>(0xfafbfbfbu, 0xf9f9fafau, 0xf7f7f8f8u, 0xf4f5f5f6u); }
        case 8u: { v = vec4<u32>(0xf0f9ffffu, 0xf6f3f0eeu, 0xfaf9f9f7u, 0xfafafafau); }
        case 9u: { v = vec4<u32>(0xf8f8f9f9u, 0xf5f6f7f7u, 0xf2f3f4f4u, 0xeeeff0f1u); }
        case 10u: { v = vec4<u32>(0xf6fdffffu, 0xf3f1eff0u, 0xf7f7f6f5u, 0xf7f8f8f8u); }
        case 11u: { v = vec4<u32>(0xf5f6f6f7u, 0xf1f2f3f4u, 0xedeeeff0u, 0xe8e9eaecu); }
        case 12u: { v = vec4<u32>(0xfafeffffu, 0xf1f0f1f4u, 0xf5f4f3f2u, 0xf5f5f5f5u); }
        case 13u: { v = vec4<u32>(0xf2f3f4f4u, 0xedeff0f1u, 0xe7e9ebecu, 0xe1e2e4e6u); }
        case 14u: { v = vec4<u32>(0xfcfeffffu, 0xf0f0f3f8u, 0xf2f2f1f0u, 0xf2f3f3f3u); }
        case 15u: { v = vec4<u32>(0xeff0f1f2u, 0xe9ebeceeu, 0xe2e4e6e7u, 0xd9dcdee0u); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xf0f2f6fau, 0xf0f0efefu, 0xf0f0f0f0u); }
        case 17u: { v = vec4<u32>(0xecedeeefu, 0xe5e7e9eau, 0xdcdee1e3u, 0xd2d5d7dau); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xf1f4f8fcu, 0xeeeeeeefu, 0xedeeeeeeu); }
        case 19u: { v = vec4<u32>(0xe8eaebecu, 0xe1e3e5e7u, 0xd6d9dcdeu, 0xcbced1d4u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xf2f6fafdu, 0xecedeef0u, 0xebebececu); }
        case 21u: { v = vec4<u32>(0xe5e7e9eau, 0xdcdfe1e3u, 0xd1d4d7dau, 0xc4c7caceu); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xf4f8fbfdu, 0xebeceef1u, 0xe8e9eaebu); }
        case 23u: { v = vec4<u32>(0xe2e4e6e7u, 0xd8dbdee0u, 0xcbcfd2d5u, 0xbdc0c4c8u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf6f9fcfeu, 0xebeceff2u, 0xe6e7e8e9u); }
        case 25u: { v = vec4<u32>(0xdfe1e3e5u, 0xd4d7daddu, 0xc6cacdd1u, 0xb6babec2u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xebedf0f4u, 0xe4e6e7e9u); }
        case 27u: { v = vec4<u32>(0xdcdfe1e3u, 0xd0d4d7dau, 0xc1c5c9cdu, 0xafb4b8bcu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xebeef2f5u, 0xe3e5e7e9u); }
        case 29u: { v = vec4<u32>(0xdadcdfe1u, 0xccd0d4d7u, 0xbbc0c4c8u, 0xa9adb2b7u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xeceff3f7u, 0xe2e4e6e9u); }
        case 31u: { v = vec4<u32>(0xd7dadddfu, 0xc9cdd1d4u, 0xb7bbc0c5u, 0xa2a8adb2u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xedf1f5f8u, 0xe1e4e7eau); }
        case 33u: { v = vec4<u32>(0xd5d8dbdeu, 0xc5caced2u, 0xb2b7bcc1u, 0x9ca2a7adu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xeff2f6f9u, 0xe1e4e7ebu); }
        case 35u: { v = vec4<u32>(0xd3d7daddu, 0xc2c7cbcfu, 0xadb3b8bdu, 0x979ca2a8u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf0f4f7fau, 0xe1e4e8ecu); }
        case 37u: { v = vec4<u32>(0xd2d6d9ddu, 0xbfc4c9cdu, 0xa9afb4bau, 0x91979da3u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f8fbu, 0xe1e5e9edu); }
        case 39u: { v = vec4<u32>(0xd0d5d9ddu, 0xbcc2c7ccu, 0xa5abb1b7u, 0x8c92999fu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf3f6f9fbu, 0xe2e6ebefu); }
        case 41u: { v = vec4<u32>(0xcfd4d9ddu, 0xbac0c5cau, 0xa1a8aeb4u, 0x878e949bu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xe3e7ecf0u); }
        case 43u: { v = vec4<u32>(0xced4d9deu, 0xb8bec3c9u, 0x9da4abb1u, 0x82899097u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fbfcu, 0xe4e9edf2u); }
        case 45u: { v = vec4<u32>(0xced4d9dfu, 0xb6bcc2c8u, 0x9aa1a8afu, 0x7e858c93u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe5eaeff3u); }
        case 47u: { v = vec4<u32>(0xced4dae0u, 0xb4bbc1c8u, 0x979ea5adu, 0x7a81888fu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe6ebf0f4u); }
        case 49u: { v = vec4<u32>(0xced5dbe1u, 0xb2b9c1c7u, 0x949ba3abu, 0x767d848cu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe8edf1f5u); }
        case 51u: { v = vec4<u32>(0xcfd5dce2u, 0xb1b9c0c7u, 0x9199a1a9u, 0x72798189u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe9eef2f6u); }
        case 53u: { v = vec4<u32>(0xcfd6dde3u, 0xb0b8c0c8u, 0x8e979fa7u, 0x6e767e86u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xeaeff3f7u); }
        case 55u: { v = vec4<u32>(0xd0d8dee5u, 0xafb8c0c8u, 0x8c959da6u, 0x6b737b83u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xecf0f4f7u); }
        case 57u: { v = vec4<u32>(0xd1d9e0e6u, 0xaeb7c0c9u, 0x8a939ca5u, 0x68707881u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xedf1f5f8u); }
        case 59u: { v = vec4<u32>(0xd2dae1e7u, 0xaeb8c1cau, 0x88919ba4u, 0x656d767eu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeef2f6f8u); }
        case 61u: { v = vec4<u32>(0xd3dbe2e9u, 0xaeb8c2cbu, 0x868f9aa4u, 0x626b737cu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xeff3f6f9u); }
        case 63u: { v = vec4<u32>(0xd5dde4eau, 0xaeb8c3ccu, 0x848e99a3u, 0x6068717au); }
        default: {}
      }
    }
    case 31u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfffefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xfbf6e7ffu, 0xfefefefdu, 0xfffefefeu, 0xfefeffffu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfefefefeu, 0xfdfdfdfeu); }
        case 4u: { v = vec4<u32>(0xf3edf9ffu, 0xfcfbfaf8u, 0xfdfdfdfdu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfdfdfdfdu, 0xfcfcfcfcu, 0xfbfbfbfbu, 0xf9fafafau); }
        case 6u: { v = vec4<u32>(0xf0f4feffu, 0xf9f8f6f3u, 0xfbfbfbfau, 0xfbfbfbfbu); }
        case 7u: { v = vec4<u32>(0xfafbfbfbu, 0xf9f9f9fau, 0xf6f7f8f8u, 0xf4f5f5f6u); }
        case 8u: { v = vec4<u32>(0xf2faffffu, 0xf6f4f2f0u, 0xf9f9f8f7u, 0xf9f9f9f9u); }
        case 9u: { v = vec4<u32>(0xf7f8f8f9u, 0xf5f6f6f7u, 0xf2f3f3f4u, 0xeeeff0f1u); }
        case 10u: { v = vec4<u32>(0xf6fdffffu, 0xf2f0eff1u, 0xf6f5f5f3u, 0xf6f7f7f6u); }
        case 11u: { v = vec4<u32>(0xf4f5f6f6u, 0xf1f2f3f4u, 0xeceeeff0u, 0xe7e8eaebu); }
        case 12u: { v = vec4<u32>(0xfafeffffu, 0xefeeeff3u, 0xf3f2f1f0u, 0xf3f4f4f3u); }
        case 13u: { v = vec4<u32>(0xf1f2f3f3u, 0xedeeeff0u, 0xe7e8eaebu, 0xe0e2e3e5u); }
        case 14u: { v = vec4<u32>(0xfcfeffffu, 0xecedf1f6u, 0xf0efeeedu, 0xf0f1f1f0u); }
        case 15u: { v = vec4<u32>(0xedeeeff0u, 0xe8eaebecu, 0xe1e3e5e6u, 0xd9dbdddfu); }
        case 16u: { v = vec4<u32>(0xfdffffffu, 0xeceef3f9u, 0xececebebu, 0xededededu); }
        case 17u: { v = vec4<u32>(0xeaebecedu, 0xe3e5e7e8u, 0xdbdddfe1u, 0xd1d3d6d8u); }
        case 18u: { v = vec4<u32>(0xfeffffffu, 0xecf0f6fbu, 0xeae9e9eau, 0xeaeaeaeau); }
        case 19u: { v = vec4<u32>(0xe6e7e9e9u, 0xdfe1e3e4u, 0xd5d7dadcu, 0xc9cccfd2u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xeef3f8fcu, 0xe7e8e9ebu, 0xe7e7e7e7u); }
        case 21u: { v = vec4<u32>(0xe2e4e5e6u, 0xdadcdfe1u, 0xcfd2d5d7u, 0xc2c5c8ccu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xf0f5fafdu, 0xe6e7e9ecu, 0xe4e4e5e5u); }
        case 23u: { v = vec4<u32>(0xdfe0e2e3u, 0xd5d8dbddu, 0xc9cccfd2u, 0xbabec2c5u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf3f7fbfdu, 0xe5e7eaeeu, 0xe1e2e3e4u); }
        case 25u: { v = vec4<u32>(0xdbdddfe0u, 0xd1d4d7d9u, 0xc3c7caceu, 0xb3b7bbbfu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xe5e8ecf0u, 0xdfe0e2e3u); }
        case 27u: { v = vec4<u32>(0xd8dadcdeu, 0xccd0d3d5u, 0xbdc1c5c9u, 0xacb0b5b9u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xe6eaeef2u, 0xdddfe1e3u); }
        case 29u: { v = vec4<u32>(0xd5d7d9dbu, 0xc8cccfd2u, 0xb8bcc0c4u, 0xa5aaaeb3u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xe7ecf0f5u, 0xdcdee1e4u); }
        case 31u: { v = vec4<u32>(0xd2d5d7dau, 0xc4c8cccfu, 0xb2b7bcc0u, 0x9ea3a8adu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe9eef2f6u, 0xdbdee1e5u); }
        case 33u: { v = vec4<u32>(0xd0d3d6d8u, 0xc0c4c8ccu, 0xadb2b7bcu, 0x989da3a8u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f4f8u, 0xdbdfe2e7u); }
        case 35u: { v = vec4<u32>(0xcdd1d4d8u, 0xbdc1c6cau, 0xa8adb3b8u, 0x92979da3u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xedf2f6f9u, 0xdbe0e4e8u); }
        case 37u: { v = vec4<u32>(0xccd0d4d7u, 0xb9bec3c7u, 0xa3a9afb4u, 0x8c92989du); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xeff3f7fau, 0xdce1e5eau); }
        case 39u: { v = vec4<u32>(0xcacfd3d8u, 0xb6bcc1c6u, 0x9fa5abb1u, 0x868c9299u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f8fbu, 0xdde2e7ecu); }
        case 41u: { v = vec4<u32>(0xc9ced3d8u, 0xb3b9bfc4u, 0x9ba1a7adu, 0x81878e94u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf2f6f9fbu, 0xdee4e9eeu); }
        case 43u: { v = vec4<u32>(0xc9ced4d9u, 0xb1b7bdc3u, 0x969da4aau, 0x7b828990u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xe0e5ebf0u); }
        case 45u: { v = vec4<u32>(0xc8ced4dau, 0xafb5bcc2u, 0x939aa1a8u, 0x767d848bu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fbfcu, 0xe2e7ecf1u); }
        case 47u: { v = vec4<u32>(0xc8cfd5dcu, 0xadb4bbc2u, 0x8f969ea5u, 0x72798088u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe3e9eef2u); }
        case 49u: { v = vec4<u32>(0xc9d0d6ddu, 0xabb3bac1u, 0x8c939ba3u, 0x6d757c84u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe5eaeff4u); }
        case 51u: { v = vec4<u32>(0xc9d1d8dfu, 0xa9b2bac2u, 0x889199a1u, 0x69717880u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe6ecf1f5u); }
        case 53u: { v = vec4<u32>(0xcad2d9e0u, 0xa8b1bac2u, 0x858e97a0u, 0x656d757du); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fbfcfdu, 0xe8edf2f6u); }
        case 55u: { v = vec4<u32>(0xcbd3dbe2u, 0xa7b1bac3u, 0x838c959eu, 0x6169717au); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe9eff3f6u); }
        case 57u: { v = vec4<u32>(0xccd5dce3u, 0xa7b1bac3u, 0x808a939du, 0x5e666e77u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xebf0f4f7u); }
        case 59u: { v = vec4<u32>(0xced6dee5u, 0xa6b1bbc5u, 0x7e88929cu, 0x5a626b74u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 61u: { v = vec4<u32>(0xcfd8dfe6u, 0xa6b1bcc6u, 0x7c86919bu, 0x575f6872u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xedf2f5f8u); }
        case 63u: { v = vec4<u32>(0xd1d9e1e8u, 0xa6b2bdc7u, 0x7a84909bu, 0x545d666fu); }
        default: {}
      }
    }
    case 32u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfffffeffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xfffffeffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 3u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 4u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 5u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 6u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 7u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 8u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 9u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 10u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 11u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 12u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 13u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 14u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 15u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 16u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 17u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 18u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 19u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 20u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 21u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 22u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 23u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 25u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 27u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 29u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 31u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 33u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 35u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 37u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 39u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 41u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 43u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 45u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 47u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 49u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 51u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 53u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 55u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 57u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 59u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 61u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        default: {}
      }
    }
    case 33u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xdceff6ffu, 0x6785a4c3u, 0x202b3a4eu, 0x0c0f1318u); }
        case 1u: { v = vec4<u32>(0x0607080au, 0x05050506u, 0x05040505u, 0x05050505u); }
        case 2u: { v = vec4<u32>(0xdae7e2ffu, 0x6886a5c2u, 0x242e3d50u, 0x1416191eu); }
        case 3u: { v = vec4<u32>(0x13131313u, 0x18161514u, 0x1e1c1b19u, 0x26242220u); }
        case 4u: { v = vec4<u32>(0xd4ddf5ffu, 0x6d89a7c2u, 0x32394556u, 0x2d2c2c2eu); }
        case 5u: { v = vec4<u32>(0x3835322fu, 0x46423f3bu, 0x524f4c49u, 0x5b595754u); }
        case 6u: { v = vec4<u32>(0xd4e8fdffu, 0x748eaac2u, 0x464a5260u, 0x4c494746u); }
        case 7u: { v = vec4<u32>(0x5a565350u, 0x64625f5du, 0x6c6a6866u, 0x706f6e6du); }
        case 8u: { v = vec4<u32>(0xddf4feffu, 0x7e95afc7u, 0x5e5f646eu, 0x6563605fu); }
        case 9u: { v = vec4<u32>(0x6e6c6a67u, 0x7372716fu, 0x77767574u, 0x79787877u); }
        case 10u: { v = vec4<u32>(0xe8faffffu, 0x8b9eb6d0u, 0x7475787fu, 0x76757574u); }
        case 11u: { v = vec4<u32>(0x79797877u, 0x7b7b7b7au, 0x7d7c7c7cu, 0x7d7d7d7du); }
        case 12u: { v = vec4<u32>(0xf0fcffffu, 0x9cabc0d9u, 0x87898d93u, 0x83838485u); }
        case 13u: { v = vec4<u32>(0x82828283u, 0x81818182u, 0x81818181u, 0x80808181u); }
        case 14u: { v = vec4<u32>(0xf4fdffffu, 0xb0bccde2u, 0x979ba0a7u, 0x8d8f9194u); }
        case 15u: { v = vec4<u32>(0x898a8b8cu, 0x86868788u, 0x84858585u, 0x83838484u); }
        case 16u: { v = vec4<u32>(0xf7fdffffu, 0xc3cfdeedu, 0xa6abb1b9u, 0x979a9da1u); }
        case 17u: { v = vec4<u32>(0x8f919294u, 0x8a8b8c8eu, 0x8788898au, 0x86868687u); }
        case 18u: { v = vec4<u32>(0xfcfeffffu, 0xd4e0ecf6u, 0xb3bac1cau, 0xa0a4a8adu); }
        case 19u: { v = vec4<u32>(0x95989a9du, 0x8f909293u, 0x8b8c8d8eu, 0x8889898au); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe2ecf4fau, 0xc0c8d0d8u, 0xaaafb4bau); }
        case 21u: { v = vec4<u32>(0x9c9fa2a6u, 0x9496979au, 0x8e909192u, 0x8b8c8d8du); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f9fcu, 0xcdd5dce5u, 0xb4b9bfc6u); }
        case 23u: { v = vec4<u32>(0xa3a7abafu, 0x999b9ea0u, 0x92949597u, 0x8e8f9091u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xf4f8fcfeu, 0xd8e0e7eeu, 0xbec4cad1u); }
        case 25u: { v = vec4<u32>(0xabafb3b8u, 0x9ea1a4a7u, 0x97989a9cu, 0x91929495u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xe1e8eef3u, 0xc7cdd4dbu); }
        case 27u: { v = vec4<u32>(0xb2b7bcc1u, 0xa4a7abaeu, 0x9b9d9fa2u, 0x95969799u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe9eef3f7u, 0xd0d6dce3u); }
        case 29u: { v = vec4<u32>(0xbabfc4cau, 0xaaaeb1b5u, 0xa0a2a4a7u, 0x989a9c9eu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xeef2f6f9u, 0xd7dde3e9u); }
        case 31u: { v = vec4<u32>(0xc1c6ccd2u, 0xb0b4b8bdu, 0xa5a7aaadu, 0x9c9ea0a2u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf2f5f8fbu, 0xdee4e9eeu); }
        case 33u: { v = vec4<u32>(0xc9ced3d9u, 0xb7bbbfc4u, 0xaaadb0b3u, 0xa0a2a5a7u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xe4e9edf1u); }
        case 35u: { v = vec4<u32>(0xcfd4dadfu, 0xbdc1c6cau, 0xafb2b6b9u, 0xa5a7aaacu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xe9edf1f4u); }
        case 37u: { v = vec4<u32>(0xd6dbdfe4u, 0xc3c8ccd1u, 0xb5b8bcbfu, 0xaaacafb2u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xedf0f4f6u); }
        case 39u: { v = vec4<u32>(0xdce0e5e9u, 0xcaced2d7u, 0xbabec2c6u, 0xaeb1b4b7u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf0f3f6f8u); }
        case 41u: { v = vec4<u32>(0xe1e5e9edu, 0xd0d4d8ddu, 0xc0c4c8ccu, 0xb4b7babdu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f6f8fau); }
        case 43u: { v = vec4<u32>(0xe6e9edf0u, 0xd6dadee2u, 0xc6caced2u, 0xb9bcbfc3u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfefeu, 0xf5f7f9fbu); }
        case 45u: { v = vec4<u32>(0xeaedf0f3u, 0xdbdfe3e6u, 0xccd0d4d7u, 0xbfc2c5c9u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf7f9fafcu); }
        case 47u: { v = vec4<u32>(0xeef0f3f5u, 0xe1e4e7ebu, 0xd2d6d9ddu, 0xc5c8cbcfu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf9fafbfcu); }
        case 49u: { v = vec4<u32>(0xf1f3f5f7u, 0xe6e9eceeu, 0xd8dcdfe2u, 0xcbced2d5u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 51u: { v = vec4<u32>(0xf4f6f8f9u, 0xeaedeff2u, 0xdee1e4e7u, 0xd2d5d8dbu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfeu); }
        case 53u: { v = vec4<u32>(0xf6f8f9fau, 0xeef1f3f5u, 0xe4e7e9ecu, 0xd8dbdee1u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfefeu); }
        case 55u: { v = vec4<u32>(0xf9fafbfcu, 0xf2f4f6f7u, 0xeaeceef0u, 0xe0e2e5e7u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 57u: { v = vec4<u32>(0xfbfbfcfdu, 0xf6f7f8fau, 0xeff1f3f4u, 0xe7e9ebedu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 59u: { v = vec4<u32>(0xfcfdfdfeu, 0xf9fafbfcu, 0xf5f6f7f8u, 0xeef0f2f3u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 61u: { v = vec4<u32>(0xfefefefeu, 0xfcfdfdfdu, 0xfafafbfcu, 0xf6f7f8f9u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfefefefeu); }
        default: {}
      }
    }
    case 34u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xedf6f8ffu, 0xa7bcd0e0u, 0x54667b90u, 0x262e3845u); }
        case 1u: { v = vec4<u32>(0x12161a1fu, 0x0b0c0e10u, 0x0708090au, 0x06060607u); }
        case 2u: { v = vec4<u32>(0xeaede3ffu, 0xa7bccfdfu, 0x55677b91u, 0x28303a46u); }
        case 3u: { v = vec4<u32>(0x16191c21u, 0x0f101213u, 0x0e0e0e0fu, 0x0f0e0e0eu); }
        case 4u: { v = vec4<u32>(0xe0e0f6ffu, 0xa8bccedbu, 0x58697d92u, 0x2e353e4au); }
        case 5u: { v = vec4<u32>(0x20222528u, 0x1f1f1f1fu, 0x23222020u, 0x29272624u); }
        case 6u: { v = vec4<u32>(0xdceafdffu, 0xa9bcccd6u, 0x5d6d8094u, 0x383d454fu); }
        case 7u: { v = vec4<u32>(0x31313234u, 0x35343231u, 0x3f3c3a38u, 0x48464341u); }
        case 8u: { v = vec4<u32>(0xe2f5feffu, 0xabbdcbd6u, 0x63728497u, 0x45494f58u); }
        case 9u: { v = vec4<u32>(0x44434343u, 0x4d4a4846u, 0x5654524fu, 0x5f5d5b59u); }
        case 10u: { v = vec4<u32>(0xecfaffffu, 0xaebfcedcu, 0x6c79899bu, 0x55575b62u); }
        case 11u: { v = vec4<u32>(0x57565454u, 0x5f5d5b59u, 0x67656361u, 0x6c6b6a68u); }
        case 12u: { v = vec4<u32>(0xf4fdffffu, 0xb2c3d4e4u, 0x75818fa0u, 0x6566696eu); }
        case 13u: { v = vec4<u32>(0x67666564u, 0x6d6c6a69u, 0x7271706eu, 0x75747373u); }
        case 14u: { v = vec4<u32>(0xf8feffffu, 0xb7c9dbecu, 0x818a97a6u, 0x7475777bu); }
        case 15u: { v = vec4<u32>(0x75747473u, 0x77777675u, 0x79797878u, 0x7b7a7a7au); }
        case 16u: { v = vec4<u32>(0xfbfeffffu, 0xbed0e2f1u, 0x8e96a0adu, 0x82838589u); }
        case 17u: { v = vec4<u32>(0x7f808081u, 0x7f7f7f7fu, 0x7f7f7f7fu, 0x7f7f7f7fu); }
        case 18u: { v = vec4<u32>(0xfcfeffffu, 0xc6d6e7f5u, 0x9ca3abb7u, 0x8e919397u); }
        case 19u: { v = vec4<u32>(0x898a8b8cu, 0x86868788u, 0x84858585u, 0x83838484u); }
        case 20u: { v = vec4<u32>(0xfcffffffu, 0xd0deecf6u, 0xaab1b9c3u, 0x9a9da0a5u); }
        case 21u: { v = vec4<u32>(0x91939597u, 0x8c8d8e90u, 0x89898a8bu, 0x86878788u); }
        case 22u: { v = vec4<u32>(0xfcfeffffu, 0xdbe7f0f8u, 0xb7bec7d0u, 0xa4a8acb1u); }
        case 23u: { v = vec4<u32>(0x999b9ea1u, 0x92939597u, 0x8d8e8f90u, 0x8a8b8b8cu); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xe6eff7fbu, 0xc4cbd3dcu, 0xaeb3b8bdu); }
        case 25u: { v = vec4<u32>(0xa1a4a7aau, 0x989a9c9eu, 0x92939496u, 0x8d8e8f90u); }
        case 26u: { v = vec4<u32>(0xfeffffffu, 0xeff5fafdu, 0xcfd6dee7u, 0xb8bdc2c8u); }
        case 27u: { v = vec4<u32>(0xa8acb0b4u, 0x9ea0a2a5u, 0x96989a9bu, 0x91929395u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf4f9fcfeu, 0xd9e0e7eeu, 0xc2c7cdd3u); }
        case 29u: { v = vec4<u32>(0xb0b4b8bdu, 0xa4a7aaadu, 0x9b9d9fa1u, 0x95969899u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xe2e8eef3u, 0xcbd1d6dcu); }
        case 31u: { v = vec4<u32>(0xb8bdc1c6u, 0xaaadb1b4u, 0xa0a2a5a7u, 0x999b9c9eu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xeaeff3f7u, 0xd4dadfe5u); }
        case 33u: { v = vec4<u32>(0xc1c5cacfu, 0xb1b5b8bcu, 0xa6a8abaeu, 0x9d9fa1a3u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf0f4f7fau, 0xdce1e6ebu); }
        case 35u: { v = vec4<u32>(0xc9cdd2d7u, 0xb8bcc0c4u, 0xabaeb1b4u, 0xa2a4a6a9u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f7f9fbu, 0xe3e8ecf0u); }
        case 37u: { v = vec4<u32>(0xd0d5d9deu, 0xbfc3c7cbu, 0xb1b4b7bbu, 0xa7a9acaeu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xe9edf0f4u); }
        case 39u: { v = vec4<u32>(0xd7dbe0e4u, 0xc5caced2u, 0xb7babec2u, 0xacaeb1b4u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xedf1f4f6u); }
        case 41u: { v = vec4<u32>(0xdde1e5e9u, 0xccd0d4d9u, 0xbdc1c4c8u, 0xb1b4b7bau); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf1f4f6f8u); }
        case 43u: { v = vec4<u32>(0xe2e6eaeeu, 0xd2d6dadeu, 0xc3c7cbceu, 0xb7babdc0u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8fau); }
        case 45u: { v = vec4<u32>(0xe7ebeef1u, 0xd8dce0e4u, 0xcacdd1d5u, 0xbdc0c3c6u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 47u: { v = vec4<u32>(0xeceff1f4u, 0xdee2e5e8u, 0xd0d3d7dau, 0xc3c6c9ccu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 49u: { v = vec4<u32>(0xeff2f4f6u, 0xe3e7eaedu, 0xd6d9dde0u, 0xc9cccfd3u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xfafbfcfdu); }
        case 51u: { v = vec4<u32>(0xf3f5f7f8u, 0xe8ebeef0u, 0xdcdfe2e5u, 0xcfd3d6d9u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfbfcfdfdu); }
        case 53u: { v = vec4<u32>(0xf5f7f9fau, 0xedeff1f4u, 0xe2e5e8eau, 0xd6d9dcdfu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfdfeu); }
        case 55u: { v = vec4<u32>(0xf8f9fafbu, 0xf1f3f5f6u, 0xe8eaedefu, 0xdde0e3e5u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 57u: { v = vec4<u32>(0xfafbfcfcu, 0xf5f6f8f9u, 0xeef0f1f3u, 0xe5e7e9ebu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefefeu); }
        case 59u: { v = vec4<u32>(0xfcfcfdfdu, 0xf8f9fafbu, 0xf3f4f6f7u, 0xeceef0f1u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefeffffu); }
        case 61u: { v = vec4<u32>(0xfdfefefeu, 0xfbfcfcfdu, 0xf8f9fafbu, 0xf4f5f6f7u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 63u: { v = vec4<u32>(0xfefeffffu, 0xfdfefefeu, 0xfcfdfdfdu, 0xfafbfbfcu); }
        default: {}
      }
    }
    case 35u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xf3f9f9ffu, 0xc3d2e0ebu, 0x7d8fa0b2u, 0x44505d6cu); }
        case 1u: { v = vec4<u32>(0x252b323au, 0x16191c20u, 0x0f101214u, 0x0b0c0d0eu); }
        case 2u: { v = vec4<u32>(0xefefe3ffu, 0xc3d2dfe9u, 0x7d8fa1b2u, 0x45505e6du); }
        case 3u: { v = vec4<u32>(0x262c333bu, 0x181a1e21u, 0x12131416u, 0x0f0f1011u); }
        case 4u: { v = vec4<u32>(0xe4e1f6ffu, 0xc3d1dce3u, 0x7e90a1b2u, 0x47525f6eu); }
        case 5u: { v = vec4<u32>(0x2b30363eu, 0x1f212326u, 0x1b1b1c1du, 0x1b1b1b1bu); }
        case 6u: { v = vec4<u32>(0xdfeafdffu, 0xc2cfd8ddu, 0x8091a2b3u, 0x4b566270u); }
        case 7u: { v = vec4<u32>(0x32363c43u, 0x2a2b2c2eu, 0x2a292929u, 0x2e2d2c2bu); }
        case 8u: { v = vec4<u32>(0xe4f5feffu, 0xc2cdd5dbu, 0x8393a4b4u, 0x515a6674u); }
        case 9u: { v = vec4<u32>(0x3c3f4349u, 0x38383839u, 0x3c3b3938u, 0x4341403eu); }
        case 10u: { v = vec4<u32>(0xedfbffffu, 0xc2cdd6dfu, 0x8696a6b5u, 0x58606b78u); }
        case 11u: { v = vec4<u32>(0x47494d51u, 0x48474646u, 0x4e4c4a49u, 0x56545250u); }
        case 12u: { v = vec4<u32>(0xf5fdffffu, 0xc4cfdae7u, 0x8a99a8b7u, 0x6068717cu); }
        case 13u: { v = vec4<u32>(0x5455585bu, 0x57555554u, 0x5d5b5a58u, 0x6462615fu); }
        case 14u: { v = vec4<u32>(0xf9feffffu, 0xc7d3e0eeu, 0x8e9cabb9u, 0x6a707882u); }
        case 15u: { v = vec4<u32>(0x61626366u, 0x64636261u, 0x69686765u, 0x6e6d6c6au); }
        case 16u: { v = vec4<u32>(0xfbfeffffu, 0xcbd9e7f3u, 0x94a1afbdu, 0x74798089u); }
        case 17u: { v = vec4<u32>(0x6e6e6f71u, 0x706f6e6eu, 0x73727170u, 0x75757473u); }
        case 18u: { v = vec4<u32>(0xfcffffffu, 0xd1dfedf7u, 0x9ba6b4c2u, 0x80848991u); }
        case 19u: { v = vec4<u32>(0x797a7b7du, 0x79797979u, 0x7a7a7a79u, 0x7b7b7b7au); }
        case 20u: { v = vec4<u32>(0xfdffffffu, 0xd6e5f1f9u, 0xa2adb9c7u, 0x8b8f949au); }
        case 21u: { v = vec4<u32>(0x84858688u, 0x81828283u, 0x80818181u, 0x80808080u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xdbe9f4fau, 0xacb5c0cdu, 0x969a9fa4u); }
        case 23u: { v = vec4<u32>(0x8d8f9193u, 0x898a8b8cu, 0x86878788u, 0x84858586u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xe0ecf5fbu, 0xb6bfc9d4u, 0xa1a5aab0u); }
        case 25u: { v = vec4<u32>(0x96989b9eu, 0x8f919294u, 0x8b8c8d8eu, 0x88898a8au); }
        case 26u: { v = vec4<u32>(0xfeffffffu, 0xe6eff6fbu, 0xc2cad3ddu, 0xabb0b5bbu); }
        case 27u: { v = vec4<u32>(0x9ea1a4a8u, 0x96989a9cu, 0x90919394u, 0x8c8d8e8fu); }
        case 28u: { v = vec4<u32>(0xfeffffffu, 0xedf4f9fcu, 0xccd4dde5u, 0xb5babfc5u); }
        case 29u: { v = vec4<u32>(0xa6a9adb1u, 0x9c9ea1a3u, 0x9597989au, 0x90919394u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xd6dee5edu, 0xbec3c9cfu); }
        case 31u: { v = vec4<u32>(0xaeb2b6bau, 0xa3a5a8abu, 0x9a9c9ea0u, 0x95969799u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xdfe6ecf2u, 0xc7cdd2d8u); }
        case 33u: { v = vec4<u32>(0xb6babec3u, 0xa9acafb3u, 0xa0a2a4a7u, 0x999a9c9eu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe6ecf2f6u, 0xd0d5dbe1u); }
        case 35u: { v = vec4<u32>(0xbec2c7cbu, 0xb0b3b7bau, 0xa6a8aaadu, 0x9e9fa1a3u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xedf1f5f9u, 0xd8dde2e8u); }
        case 37u: { v = vec4<u32>(0xc6cacfd3u, 0xb7bbbec2u, 0xabaeb1b4u, 0xa2a4a7a9u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf2f5f8fbu, 0xe0e5e9eeu); }
        case 39u: { v = vec4<u32>(0xced2d7dbu, 0xbec2c6cau, 0xb2b5b8bbu, 0xa8aaacafu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xe7ebeff2u); }
        case 41u: { v = vec4<u32>(0xd6dadee2u, 0xc6c9cdd1u, 0xb8bbbec2u, 0xadb0b2b5u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xecf0f3f6u); }
        case 43u: { v = vec4<u32>(0xdce0e4e8u, 0xcdd0d4d8u, 0xbec2c5c9u, 0xb3b5b8bbu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xf0f3f6f8u); }
        case 45u: { v = vec4<u32>(0xe2e6eaedu, 0xd3d7dbdfu, 0xc5c8cccfu, 0xb9bbbec2u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf4f6f8fau); }
        case 47u: { v = vec4<u32>(0xe8ebeef1u, 0xdadde1e4u, 0xcbcfd2d6u, 0xbfc2c5c8u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 49u: { v = vec4<u32>(0xeceff2f4u, 0xdfe3e6e9u, 0xd2d5d9dcu, 0xc5c8cbcfu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 51u: { v = vec4<u32>(0xf0f3f5f7u, 0xe5e8ebeeu, 0xd8dbdfe2u, 0xcccfd2d5u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefeffu, 0xfafbfcfdu); }
        case 53u: { v = vec4<u32>(0xf3f5f7f9u, 0xeaedeff1u, 0xdfe1e4e7u, 0xd3d6d9dcu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 55u: { v = vec4<u32>(0xf6f8f9fau, 0xeff1f3f5u, 0xe5e7eaecu, 0xdadddfe2u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfefeu); }
        case 57u: { v = vec4<u32>(0xf9fafbfcu, 0xf3f4f6f7u, 0xebedeff1u, 0xe1e4e6e8u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 59u: { v = vec4<u32>(0xfbfcfcfdu, 0xf6f8f9fau, 0xf0f2f4f5u, 0xe9ebedeeu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 61u: { v = vec4<u32>(0xfcfdfdfeu, 0xfafbfbfcu, 0xf6f7f8f9u, 0xf0f2f3f4u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 63u: { v = vec4<u32>(0xfdfefefeu, 0xfcfcfdfdu, 0xf9fafafbu, 0xf4f5f7f8u); }
        default: {}
      }
    }
    case 36u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xf6faf9ffu, 0xd2dee8f0u, 0x99a9b7c5u, 0x616e7b8au); }
        case 1u: { v = vec4<u32>(0x3a424b55u, 0x24292d33u, 0x191b1e21u, 0x13141617u); }
        case 2u: { v = vec4<u32>(0xf2f0e3ffu, 0xd2dde7eeu, 0x99a9b7c5u, 0x616e7c8au); }
        case 3u: { v = vec4<u32>(0x3b424b56u, 0x25292e34u, 0x1a1d1f22u, 0x15161719u); }
        case 4u: { v = vec4<u32>(0xe6e2f6ffu, 0xd1dbe3e7u, 0x9aa9b7c5u, 0x626f7c8bu); }
        case 5u: { v = vec4<u32>(0x3d444d57u, 0x292c3136u, 0x1f212326u, 0x1c1c1d1eu); }
        case 6u: { v = vec4<u32>(0xe0eafdffu, 0xd0d8dee0u, 0x9ba9b8c4u, 0x64707e8cu); }
        case 7u: { v = vec4<u32>(0x40475059u, 0x2f32363au, 0x28292a2cu, 0x27272727u); }
        case 8u: { v = vec4<u32>(0xe5f6feffu, 0xced6daddu, 0x9caab8c4u, 0x6773808du); }
        case 9u: { v = vec4<u32>(0x454c535cu, 0x37393c40u, 0x33333435u, 0x35343333u); }
        case 10u: { v = vec4<u32>(0xeefbffffu, 0xcdd4dae1u, 0x9dabb8c4u, 0x6a75828fu); }
        case 11u: { v = vec4<u32>(0x4c515860u, 0x40424448u, 0x403f3f40u, 0x44434241u); }
        case 12u: { v = vec4<u32>(0xf5fdffffu, 0xcdd5dde8u, 0x9fadb9c4u, 0x6e798592u); }
        case 13u: { v = vec4<u32>(0x53585e65u, 0x4c4c4e50u, 0x4d4c4c4bu, 0x5351504fu); }
        case 14u: { v = vec4<u32>(0xf9feffffu, 0xcfd8e3efu, 0xa1aebac5u, 0x737d8894u); }
        case 15u: { v = vec4<u32>(0x5c60656bu, 0x5757585au, 0x5a595857u, 0x5f5e5d5bu); }
        case 16u: { v = vec4<u32>(0xfbfeffffu, 0xd3dde9f4u, 0xa4b1bdc8u, 0x79828c98u); }
        case 17u: { v = vec4<u32>(0x66686d72u, 0x62626364u, 0x65646363u, 0x69686766u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xd7e3eff8u, 0xa7b4c0ccu, 0x8088919cu); }
        case 19u: { v = vec4<u32>(0x6f72757au, 0x6d6d6d6eu, 0x6f6e6d6du, 0x7171706fu); }
        case 20u: { v = vec4<u32>(0xfdffffffu, 0xdde8f3fau, 0xabb7c4d0u, 0x878e96a0u); }
        case 21u: { v = vec4<u32>(0x797b7e82u, 0x76767778u, 0x77767676u, 0x78787777u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xe1edf6fbu, 0xb0bcc8d5u, 0x90959da6u); }
        case 23u: { v = vec4<u32>(0x8385878bu, 0x7f7f8081u, 0x7e7e7e7eu, 0x7d7d7e7eu); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xe6f0f8fcu, 0xb6c1cddau, 0x989ea4acu); }
        case 25u: { v = vec4<u32>(0x8c8e9194u, 0x8788898au, 0x84848586u, 0x82838383u); }
        case 26u: { v = vec4<u32>(0xfeffffffu, 0xe9f3f9fdu, 0xbcc7d2deu, 0xa2a7adb4u); }
        case 27u: { v = vec4<u32>(0x95979a9eu, 0x8e8f9193u, 0x8a8b8c8du, 0x87878889u); }
        case 28u: { v = vec4<u32>(0xfeffffffu, 0xecf4fafdu, 0xc5ced8e2u, 0xabb0b6bdu); }
        case 29u: { v = vec4<u32>(0x9da0a3a7u, 0x9597999bu, 0x8f909293u, 0x8b8c8d8eu); }
        case 30u: { v = vec4<u32>(0xfeffffffu, 0xeff5fafdu, 0xced6dfe7u, 0xb5bac0c6u); }
        case 31u: { v = vec4<u32>(0xa5a9acb0u, 0x9b9ea0a3u, 0x94969899u, 0x90919293u); }
        case 32u: { v = vec4<u32>(0xfeffffffu, 0xf3f8fbfdu, 0xd7dee6edu, 0xbdc3c9cfu); }
        case 33u: { v = vec4<u32>(0xadb1b5b9u, 0xa2a4a7aau, 0x9a9c9ea0u, 0x94959798u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xdfe6edf3u, 0xc6ccd2d8u); }
        case 35u: { v = vec4<u32>(0xb5b9bdc1u, 0xa9abaeb1u, 0x9fa1a4a6u, 0x999a9c9du); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe6ecf2f6u, 0xced4dae0u); }
        case 37u: { v = vec4<u32>(0xbdc0c5c9u, 0xafb2b5b9u, 0xa5a7aaacu, 0x9d9fa1a3u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xecf1f5f9u, 0xd6dce1e7u); }
        case 39u: { v = vec4<u32>(0xc4c8cdd1u, 0xb6b9bdc0u, 0xabaeb0b3u, 0xa2a4a6a9u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf1f5f8fbu, 0xdee2e7ecu); }
        case 41u: { v = vec4<u32>(0xccd0d4d9u, 0xbdc1c4c8u, 0xb1b4b7bau, 0xa8aaacafu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f7fafcu, 0xe4e9edf1u); }
        case 43u: { v = vec4<u32>(0xd3d8dce0u, 0xc5c8ccd0u, 0xb8bbbec1u, 0xadb0b2b5u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafbfdu, 0xeaeef2f5u); }
        case 45u: { v = vec4<u32>(0xdbdfe3e7u, 0xcccfd3d7u, 0xbfc2c5c8u, 0xb3b6b9bcu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xfafbfcfdu, 0xeff2f5f8u); }
        case 47u: { v = vec4<u32>(0xe2e5e9ecu, 0xd3d7dadeu, 0xc5c9cccfu, 0xbabcbfc2u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f6f8fau); }
        case 49u: { v = vec4<u32>(0xe7ebeef1u, 0xdadde1e4u, 0xcccfd3d6u, 0xc0c3c6c9u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 51u: { v = vec4<u32>(0xeceff2f4u, 0xe0e3e6e9u, 0xd3d6d9ddu, 0xc7cacdd0u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 53u: { v = vec4<u32>(0xf0f3f5f7u, 0xe6e8ebeeu, 0xdadde0e3u, 0xced1d3d7u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 55u: { v = vec4<u32>(0xf4f6f7f9u, 0xebedf0f2u, 0xe0e3e6e8u, 0xd5d7daddu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 57u: { v = vec4<u32>(0xf7f8fafbu, 0xf0f2f3f5u, 0xe6e9ebedu, 0xdcdfe1e4u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 59u: { v = vec4<u32>(0xf9fafbfcu, 0xf4f5f7f8u, 0xeceef0f2u, 0xe3e5e8eau); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfdfefefeu); }
        case 61u: { v = vec4<u32>(0xfbfcfdfdu, 0xf7f8f9fau, 0xf1f3f5f6u, 0xeaeceef0u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfefefeffu); }
        case 63u: { v = vec4<u32>(0xfcfdfdfeu, 0xf9fafbfbu, 0xf4f5f7f8u, 0xeceef0f2u); }
        default: {}
      }
    }
    case 37u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xf8fbf9ffu, 0xdce5edf3u, 0xadbac6d2u, 0x798693a0u); }
        case 1u: { v = vec4<u32>(0x4f58626du, 0x353a4047u, 0x25282c30u, 0x1d1e2023u); }
        case 2u: { v = vec4<u32>(0xf3f1e3ffu, 0xdce4ecf1u, 0xadbac6d2u, 0x798693a0u); }
        case 3u: { v = vec4<u32>(0x5059636eu, 0x353b4148u, 0x26292d31u, 0x1e1f2124u); }
        case 4u: { v = vec4<u32>(0xe8e2f6ffu, 0xdae2e7eau, 0xaebac6d1u, 0x7a8693a0u); }
        case 5u: { v = vec4<u32>(0x515a636eu, 0x373c4249u, 0x292c2f33u, 0x22232527u); }
        case 6u: { v = vec4<u32>(0xe1ebfdffu, 0xd8dee2e2u, 0xaebac6d0u, 0x7b8794a1u); }
        case 7u: { v = vec4<u32>(0x535b656fu, 0x3a3f454bu, 0x2e303336u, 0x28292a2cu); }
        case 8u: { v = vec4<u32>(0xe5f6feffu, 0xd6dbdddfu, 0xaebac5ceu, 0x7c8895a2u); }
        case 9u: { v = vec4<u32>(0x555d6771u, 0x3f43484eu, 0x3536393bu, 0x32323233u); }
        case 10u: { v = vec4<u32>(0xeefbffffu, 0xd4d8dce2u, 0xafbac4cdu, 0x7e8a96a2u); }
        case 11u: { v = vec4<u32>(0x59616973u, 0x45484d52u, 0x3d3e4042u, 0x3d3c3c3du); }
        case 12u: { v = vec4<u32>(0xf5fdffffu, 0xd3d8dfe9u, 0xafbac4ccu, 0x808c97a4u); }
        case 13u: { v = vec4<u32>(0x5d646c76u, 0x4c4f5357u, 0x4747484au, 0x49484747u); }
        case 14u: { v = vec4<u32>(0xf9feffffu, 0xd4dbe4efu, 0xb0bbc5cdu, 0x838e99a5u); }
        case 15u: { v = vec4<u32>(0x62697079u, 0x5456595du, 0x51515253u, 0x54535252u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xd7e0eaf5u, 0xb2bcc6ceu, 0x86909ba7u); }
        case 17u: { v = vec4<u32>(0x686e757du, 0x5d5e6164u, 0x5b5b5b5cu, 0x5f5e5d5cu); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xdbe5eff8u, 0xb4bec8d2u, 0x8a939ea9u); }
        case 19u: { v = vec4<u32>(0x6f747a81u, 0x6567696bu, 0x65656565u, 0x68676666u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe0eaf4fau, 0xb6c1cbd6u, 0x8e97a1abu); }
        case 21u: { v = vec4<u32>(0x767a8086u, 0x6e6f7173u, 0x6e6d6d6eu, 0x6f6f6e6eu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xe5eff7fcu, 0xb9c4cfdau, 0x939ba4afu); }
        case 23u: { v = vec4<u32>(0x7e81868cu, 0x7778797bu, 0x75767676u, 0x76767676u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xe9f2f9fcu, 0xbdc8d3deu, 0x99a0a9b2u); }
        case 25u: { v = vec4<u32>(0x86898d92u, 0x7f808183u, 0x7d7d7d7eu, 0x7c7c7c7cu); }
        case 26u: { v = vec4<u32>(0xfeffffffu, 0xedf5fafdu, 0xc1ccd7e3u, 0x9fa6aeb7u); }
        case 27u: { v = vec4<u32>(0x8e919599u, 0x8688898bu, 0x83848485u, 0x81818282u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xeff6fbfdu, 0xc6d0dbe6u, 0xa6acb4bcu); }
        case 29u: { v = vec4<u32>(0x96999da1u, 0x8e8f9193u, 0x898a8b8cu, 0x86868788u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf1f7fbfeu, 0xcbd5dfe9u, 0xaeb4bbc2u); }
        case 31u: { v = vec4<u32>(0x9ea1a5a9u, 0x9597999bu, 0x8f909193u, 0x8a8b8c8du); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xd2dae3ebu, 0xb6bcc3cau); }
        case 33u: { v = vec4<u32>(0xa6a9adb1u, 0x9b9ea0a3u, 0x94969799u, 0x8f909193u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xf4f8fbfdu, 0xd9e1e8efu, 0xbfc4cbd2u); }
        case 35u: { v = vec4<u32>(0xadb1b5bau, 0xa2a4a7aau, 0x999b9d9fu, 0x93959698u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xe1e7eef3u, 0xc7cdd3dau); }
        case 37u: { v = vec4<u32>(0xb5b9bdc2u, 0xa8abaeb1u, 0x9fa1a3a6u, 0x989a9b9du); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe7edf2f7u, 0xcfd4dbe1u); }
        case 39u: { v = vec4<u32>(0xbcc0c4c9u, 0xafb2b5b8u, 0xa5a7a9acu, 0x9d9fa1a3u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd6dce1e7u); }
        case 41u: { v = vec4<u32>(0xc3c7ccd1u, 0xb5b9bcbfu, 0xabadb0b2u, 0xa2a4a6a8u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f8fbu, 0xdde2e8edu); }
        case 43u: { v = vec4<u32>(0xcbcfd3d8u, 0xbcc0c3c7u, 0xb1b3b6b9u, 0xa8aaacaeu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xe4e8edf1u); }
        case 45u: { v = vec4<u32>(0xd2d6dbdfu, 0xc3c7caceu, 0xb7babdc0u, 0xadb0b2b5u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xe9edf1f4u); }
        case 47u: { v = vec4<u32>(0xd9dde1e5u, 0xcbced2d5u, 0xbec1c4c7u, 0xb3b6b9bbu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeff2f5f7u); }
        case 49u: { v = vec4<u32>(0xe0e4e8ebu, 0xd2d5d9ddu, 0xc5c8cbcfu, 0xbabcbfc2u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f5f7f9u); }
        case 51u: { v = vec4<u32>(0xe7eaedf0u, 0xd9dce0e3u, 0xcccfd2d6u, 0xc0c3c6c9u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 53u: { v = vec4<u32>(0xeceff1f4u, 0xe0e3e6e9u, 0xd3d6d9dcu, 0xc7cacdd0u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf8fafbfcu); }
        case 55u: { v = vec4<u32>(0xf0f3f5f7u, 0xe6e9ebeeu, 0xdadde0e3u, 0xced1d4d7u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 57u: { v = vec4<u32>(0xf4f6f8f9u, 0xebeef0f2u, 0xe0e3e6e9u, 0xd5d8dbdeu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 59u: { v = vec4<u32>(0xf7f8fafbu, 0xf0f2f4f5u, 0xe7e9ebeeu, 0xdcdfe1e4u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfdfefeu); }
        case 61u: { v = vec4<u32>(0xf9fafbfcu, 0xf4f5f7f8u, 0xeceef0f2u, 0xe2e4e7e9u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfeffffffu, 0xfdfefefeu); }
        case 63u: { v = vec4<u32>(0xfafbfcfdu, 0xf5f7f8f9u, 0xeef0f2f4u, 0xe2e5e8ebu); }
        default: {}
      }
    }
    case 38u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xf9fbf9ffu, 0xe3eaf0f6u, 0xbcc7d1dbu, 0x8e99a5b1u); }
        case 1u: { v = vec4<u32>(0x646d7883u, 0x464c535bu, 0x33373b40u, 0x282a2d30u); }
        case 2u: { v = vec4<u32>(0xf5f1e3ffu, 0xe2e9eff3u, 0xbcc7d1dau, 0x8e99a5b1u); }
        case 3u: { v = vec4<u32>(0x646e7883u, 0x464d545bu, 0x34373c41u, 0x292b2d30u); }
        case 4u: { v = vec4<u32>(0xe9e3f6ffu, 0xe1e7ebecu, 0xbcc7d0d9u, 0x8e9aa5b1u); }
        case 5u: { v = vec4<u32>(0x656e7883u, 0x474d545cu, 0x35393d42u, 0x2b2d2f32u); }
        case 6u: { v = vec4<u32>(0xe1ebfdffu, 0xdee2e4e3u, 0xbcc6cfd7u, 0x8e9aa5b1u); }
        case 7u: { v = vec4<u32>(0x666f7983u, 0x494f565du, 0x383b3f44u, 0x2f313335u); }
        case 8u: { v = vec4<u32>(0xe6f6feffu, 0xdbdedfe0u, 0xbcc5ced5u, 0x8f9aa6b1u); }
        case 9u: { v = vec4<u32>(0x67707a84u, 0x4c51585fu, 0x3c3f4347u, 0x3536383au); }
        case 10u: { v = vec4<u32>(0xeefbffffu, 0xd8dbdde3u, 0xbbc5cdd3u, 0x909ba6b1u); }
        case 11u: { v = vec4<u32>(0x69717b85u, 0x4f545a61u, 0x4244474bu, 0x3c3d3e40u); }
        case 12u: { v = vec4<u32>(0xf5fdffffu, 0xd7dae0e9u, 0xbbc4ccd2u, 0x919ca7b1u); }
        case 13u: { v = vec4<u32>(0x6b747d87u, 0x53585e64u, 0x484a4d50u, 0x45454647u); }
        case 14u: { v = vec4<u32>(0xf9feffffu, 0xd7dde5f0u, 0xbcc4ccd2u, 0x929da8b2u); }
        case 15u: { v = vec4<u32>(0x6e767f88u, 0x595d6267u, 0x50515355u, 0x4e4e4e4fu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xd9e1ebf5u, 0xbcc5ccd3u, 0x949ea9b3u); }
        case 17u: { v = vec4<u32>(0x7279818au, 0x5f62666cu, 0x58585a5cu, 0x58575757u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xdde6f0f8u, 0xbdc6ced5u, 0x96a0aab4u); }
        case 19u: { v = vec4<u32>(0x767d848du, 0x65686c70u, 0x60606163u, 0x6060605fu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe2ebf4fau, 0xbfc8d0d9u, 0x99a2acb6u); }
        case 21u: { v = vec4<u32>(0x7b818890u, 0x6c6e7175u, 0x6868696au, 0x68686867u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xe7f0f7fcu, 0xc1cbd4ddu, 0x9ba4aeb8u); }
        case 23u: { v = vec4<u32>(0x80858c93u, 0x7375787bu, 0x6f707071u, 0x6f6f6f6fu); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xebf3f9fdu, 0xc4ced8e1u, 0x9fa7b1bau); }
        case 25u: { v = vec4<u32>(0x858a9097u, 0x7a7c7e81u, 0x76777879u, 0x76767676u); }
        case 26u: { v = vec4<u32>(0xfeffffffu, 0xeef6fafdu, 0xc7d1dce6u, 0xa3abb4bdu); }
        case 27u: { v = vec4<u32>(0x8c90959bu, 0x81838588u, 0x7d7e7e80u, 0x7b7c7c7cu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf1f7fbfeu, 0xcbd5dfe9u, 0xa7afb7c1u); }
        case 29u: { v = vec4<u32>(0x92969ba1u, 0x888a8c8fu, 0x83848586u, 0x80818282u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf3f9fcfeu, 0xcfd9e3ecu, 0xadb4bcc5u); }
        case 31u: { v = vec4<u32>(0x999da1a7u, 0x8f919396u, 0x898a8b8du, 0x85868788u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf5fafdfeu, 0xd3dce6eeu, 0xb3bac1c9u); }
        case 33u: { v = vec4<u32>(0xa0a4a8adu, 0x95989a9du, 0x8f909293u, 0x8a8b8c8du); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xf6fafdfeu, 0xd7e0e8f0u, 0xbac0c7cfu); }
        case 35u: { v = vec4<u32>(0xa7abb0b4u, 0x9c9ea1a4u, 0x9496989au, 0x8e909192u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xf6fafdfeu, 0xdde4ebf1u, 0xc1c8ced5u); }
        case 37u: { v = vec4<u32>(0xafb2b7bcu, 0xa2a5a8abu, 0x999b9da0u, 0x93949698u); }
        case 38u: { v = vec4<u32>(0xfeffffffu, 0xf8fafcfeu, 0xe3e9eff4u, 0xc9cfd5dcu); }
        case 39u: { v = vec4<u32>(0xb5babec3u, 0xa8abaeb2u, 0x9fa1a3a6u, 0x98999b9du); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe9eef3f7u, 0xd0d6dce3u); }
        case 41u: { v = vec4<u32>(0xbcc1c5cbu, 0xafb2b5b8u, 0xa4a7a9acu, 0x9d9ea0a2u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xeef3f7fau, 0xd7dde3e9u); }
        case 43u: { v = vec4<u32>(0xc3c8cdd2u, 0xb5b8bcbfu, 0xaaadafb2u, 0xa2a4a6a8u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf2f6f9fbu, 0xdee3e9eeu); }
        case 45u: { v = vec4<u32>(0xcacfd4d9u, 0xbcbfc2c6u, 0xb0b3b6b8u, 0xa7a9abaeu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xe4e9edf2u); }
        case 47u: { v = vec4<u32>(0xd1d6dadfu, 0xc2c6cacdu, 0xb7b9bcbfu, 0xadafb1b4u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe9edf1f5u); }
        case 49u: { v = vec4<u32>(0xd9dde1e5u, 0xcacdd1d4u, 0xbdc0c3c6u, 0xb3b5b8bau); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeef2f5f7u); }
        case 51u: { v = vec4<u32>(0xdfe3e7ebu, 0xd1d4d8dcu, 0xc4c7cacdu, 0xb9bcbec1u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f5f7f9u); }
        case 53u: { v = vec4<u32>(0xe6e9edf0u, 0xd8dcdfe2u, 0xcbced1d5u, 0xc0c2c5c8u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 55u: { v = vec4<u32>(0xeceff1f4u, 0xdfe2e5e9u, 0xd2d5d9dcu, 0xc6c9cccfu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf9fafbfcu); }
        case 57u: { v = vec4<u32>(0xf0f3f5f7u, 0xe5e8ebeeu, 0xd9dcdfe2u, 0xcdd0d3d6u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 59u: { v = vec4<u32>(0xf4f6f8f9u, 0xebedf0f2u, 0xdfe2e5e8u, 0xd3d6d9dcu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfcfdfeu); }
        case 61u: { v = vec4<u32>(0xf7f8fafbu, 0xeff1f3f5u, 0xe4e7eaecu, 0xd7dadde1u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfcfdfefeu); }
        case 63u: { v = vec4<u32>(0xf8fafbfcu, 0xf1f3f5f7u, 0xe6e9ecefu, 0xd7dbdfe3u); }
        default: {}
      }
    }
    case 39u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfafcfaffu, 0xe8eef3f7u, 0xc8d1d9e1u, 0x9fa9b4beu); }
        case 1u: { v = vec4<u32>(0x77808a94u, 0x585e666eu, 0x42474c51u, 0x35373b3eu); }
        case 2u: { v = vec4<u32>(0xf5f1e3ffu, 0xe7edf2f5u, 0xc7d1d9e1u, 0x9fa9b4beu); }
        case 3u: { v = vec4<u32>(0x77808a94u, 0x585f666eu, 0x42474c51u, 0x35383b3eu); }
        case 4u: { v = vec4<u32>(0xe9e3f6ffu, 0xe5eaededu, 0xc7d0d8dfu, 0x9fa9b4beu); }
        case 5u: { v = vec4<u32>(0x77808a94u, 0x585f666eu, 0x43474c52u, 0x36393c3fu); }
        case 6u: { v = vec4<u32>(0xe2ebfdffu, 0xe2e5e6e4u, 0xc7cfd7ddu, 0x9fa9b3bdu); }
        case 7u: { v = vec4<u32>(0x77818a95u, 0x595f676fu, 0x45494d53u, 0x383b3e41u); }
        case 8u: { v = vec4<u32>(0xe6f6feffu, 0xdfe1e1e0u, 0xc6ced5dbu, 0x9fa9b3bdu); }
        case 9u: { v = vec4<u32>(0x78818b95u, 0x5a616870u, 0x474b4f54u, 0x3c3e4144u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xdbdddee3u, 0xc5cdd3d8u, 0x9fa9b3bdu); }
        case 11u: { v = vec4<u32>(0x79828b95u, 0x5c626971u, 0x4a4e5257u, 0x41434547u); }
        case 12u: { v = vec4<u32>(0xf5fdffffu, 0xd9dce1eau, 0xc5ccd2d6u, 0xa0aab3bcu); }
        case 13u: { v = vec4<u32>(0x7a838c96u, 0x5f646b72u, 0x4e52555au, 0x47484a4cu); }
        case 14u: { v = vec4<u32>(0xf9feffffu, 0xd9dee6f0u, 0xc4cbd1d5u, 0xa0aab3bcu); }
        case 15u: { v = vec4<u32>(0x7c848d97u, 0x62676d74u, 0x5356595du, 0x4e4f5051u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xdbe2ebf5u, 0xc4cbd1d6u, 0xa1abb4bcu); }
        case 17u: { v = vec4<u32>(0x7e868e98u, 0x656a7076u, 0x595b5e61u, 0x55555657u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xdfe7f1f8u, 0xc4cbd2d8u, 0xa2abb4bdu); }
        case 19u: { v = vec4<u32>(0x80889099u, 0x6a6e7379u, 0x5f616366u, 0x5c5d5d5eu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe3ecf4fau, 0xc6cdd4dbu, 0xa3acb5beu); }
        case 21u: { v = vec4<u32>(0x838a929bu, 0x6e72777cu, 0x6667696bu, 0x64646465u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xe8f0f7fcu, 0xc7cfd7dfu, 0xa5aeb7bfu); }
        case 23u: { v = vec4<u32>(0x868d949cu, 0x74777b80u, 0x6c6d6f71u, 0x6a6a6b6bu); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xecf4f9fdu, 0xcad2dbe3u, 0xa7b0b8c1u); }
        case 25u: { v = vec4<u32>(0x8a90979fu, 0x797c8084u, 0x72737577u, 0x71717172u); }
        case 26u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fbfdu, 0xcdd6dfe7u, 0xa9b2bbc4u); }
        case 27u: { v = vec4<u32>(0x8e949aa1u, 0x7f828589u, 0x797a7b7du, 0x76777778u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf2f8fcfeu, 0xd0d9e2ebu, 0xacb4bdc6u); }
        case 29u: { v = vec4<u32>(0x93989ea5u, 0x85878b8eu, 0x7e808183u, 0x7c7c7d7eu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xd3dde6eeu, 0xb0b8c0c9u); }
        case 31u: { v = vec4<u32>(0x989da2a9u, 0x8b8d9094u, 0x84868789u, 0x80818283u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf6fafdfeu, 0xd6e0e9f0u, 0xb4bbc4cdu); }
        case 33u: { v = vec4<u32>(0x9ea2a7adu, 0x9194969au, 0x8a8b8d8fu, 0x85868788u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xdae3ebf2u, 0xb9c0c8d1u); }
        case 35u: { v = vec4<u32>(0xa4a8adb2u, 0x979a9da0u, 0x8f919395u, 0x8a8b8c8eu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xdde5edf3u, 0xbfc5cdd5u); }
        case 37u: { v = vec4<u32>(0xaaaeb3b9u, 0x9da0a3a6u, 0x9496989bu, 0x8e909193u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xe1e8eff4u, 0xc5ccd2dau); }
        case 39u: { v = vec4<u32>(0xb1b5babfu, 0xa3a6a9adu, 0x9a9c9ea0u, 0x93949698u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xf9fbfdfeu, 0xe6ecf1f5u, 0xccd2d9dfu); }
        case 41u: { v = vec4<u32>(0xb7bcc0c6u, 0xa9acafb3u, 0x9fa1a3a6u, 0x97999b9du); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xebf0f4f8u, 0xd3d9dfe5u); }
        case 43u: { v = vec4<u32>(0xbec2c7cdu, 0xafb2b6b9u, 0xa4a7a9acu, 0x9c9ea0a2u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf0f4f8fau, 0xd9dfe5eau); }
        case 45u: { v = vec4<u32>(0xc4c9ced3u, 0xb5b8bcc0u, 0xaaacafb2u, 0xa1a3a5a7u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xe0e5eaefu); }
        case 47u: { v = vec4<u32>(0xcbd0d5dau, 0xbbbfc2c7u, 0xafb2b5b8u, 0xa6a8abadu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe5eaeff3u); }
        case 49u: { v = vec4<u32>(0xd2d6dbe0u, 0xc2c5c9cdu, 0xb5b8bbbeu, 0xacaeb0b3u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xeaeef2f5u); }
        case 51u: { v = vec4<u32>(0xd9dde1e6u, 0xc9ccd0d4u, 0xbcbfc2c5u, 0xb1b4b6b9u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xeff2f5f8u); }
        case 53u: { v = vec4<u32>(0xdfe3e7ebu, 0xd0d3d7dbu, 0xc3c6c9ccu, 0xb7babdc0u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f5f8f9u); }
        case 55u: { v = vec4<u32>(0xe6e9edf0u, 0xd7dbdee2u, 0xc9cdd0d3u, 0xbec0c3c6u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 57u: { v = vec4<u32>(0xebeef1f4u, 0xdee2e5e8u, 0xd0d4d7dbu, 0xc4c7cacdu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf9fafbfcu); }
        case 59u: { v = vec4<u32>(0xf0f3f5f7u, 0xe4e8ebedu, 0xd7dadee1u, 0xc9ccd0d3u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 61u: { v = vec4<u32>(0xf3f6f7f9u, 0xe9eceff1u, 0xdadee2e5u, 0xcaced2d6u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefeffffu, 0xfbfcfdfdu); }
        case 63u: { v = vec4<u32>(0xf6f8f9fau, 0xeceff2f4u, 0xdde2e5e9u, 0xcacfd4d9u); }
        default: {}
      }
    }
    case 40u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfbfcfaffu, 0xecf1f5f8u, 0xd1d8e0e6u, 0xadb6c0c8u); }
        case 1u: { v = vec4<u32>(0x88919aa4u, 0x69707880u, 0x52575c62u, 0x4246494du); }
        case 2u: { v = vec4<u32>(0xf6f2e3ffu, 0xebf0f3f6u, 0xd0d8dfe6u, 0xadb6bfc8u); }
        case 3u: { v = vec4<u32>(0x88919aa4u, 0x69707880u, 0x52575c62u, 0x4246494du); }
        case 4u: { v = vec4<u32>(0xeae3f6ffu, 0xe9edeeeeu, 0xd0d7dee4u, 0xadb6bfc8u); }
        case 5u: { v = vec4<u32>(0x88919aa4u, 0x69707780u, 0x52575c62u, 0x4346494du); }
        case 6u: { v = vec4<u32>(0xe2ebfdffu, 0xe6e8e8e5u, 0xcfd6dce2u, 0xadb6bfc7u); }
        case 7u: { v = vec4<u32>(0x88919aa3u, 0x6970777fu, 0x52575d62u, 0x44474a4eu); }
        case 8u: { v = vec4<u32>(0xe6f6feffu, 0xe2e2e2e1u, 0xced5dadfu, 0xacb5bec6u); }
        case 9u: { v = vec4<u32>(0x88919aa3u, 0x69707880u, 0x54585d63u, 0x46494c4fu); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xdedfdfe3u, 0xcdd3d8dcu, 0xacb5bec6u); }
        case 11u: { v = vec4<u32>(0x88919aa3u, 0x6a717880u, 0x555a5f64u, 0x494b4e52u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xdbdde1eau, 0xccd1d6d9u, 0xacb5bdc5u); }
        case 13u: { v = vec4<u32>(0x89919aa3u, 0x6b727981u, 0x585c6066u, 0x4d4f5154u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xdbdfe6f0u, 0xcbd0d5d8u, 0xacb5bdc4u); }
        case 15u: { v = vec4<u32>(0x89929aa3u, 0x6d737a81u, 0x5b5e6368u, 0x51535558u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xdde3ecf5u, 0xcacfd4d8u, 0xacb5bdc4u); }
        case 17u: { v = vec4<u32>(0x8a929ba4u, 0x6f757b83u, 0x5e62666au, 0x56585a5cu); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe0e8f1f8u, 0xcad0d5dau, 0xadb5bdc4u); }
        case 19u: { v = vec4<u32>(0x8b939ca4u, 0x72777d84u, 0x6365696du, 0x5c5d5e60u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe4edf5fbu, 0xcbd1d7ddu, 0xadb5bdc4u); }
        case 21u: { v = vec4<u32>(0x8d959da5u, 0x757a7f86u, 0x676a6d70u, 0x62636465u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xe9f1f8fcu, 0xccd3d9e1u, 0xaeb6bec5u); }
        case 23u: { v = vec4<u32>(0x8f969ea6u, 0x787d8288u, 0x6c6e7174u, 0x6868696bu); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xedf4fafdu, 0xced5dde5u, 0xafb7bfc7u); }
        case 25u: { v = vec4<u32>(0x91989fa7u, 0x7c80858bu, 0x71737678u, 0x6d6e6f70u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf0f7fbfdu, 0xd1d9e1e9u, 0xb1b9c1c9u); }
        case 27u: { v = vec4<u32>(0x939aa1a9u, 0x8084888eu, 0x77787a7du, 0x73737475u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xd4dce4ecu, 0xb3bbc3cbu); }
        case 29u: { v = vec4<u32>(0x979da3abu, 0x85888c91u, 0x7c7d7f82u, 0x7878797au); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf5fafdfeu, 0xd7dfe8efu, 0xb5bdc5ceu); }
        case 31u: { v = vec4<u32>(0x9aa0a6adu, 0x8a8d9195u, 0x81838587u, 0x7d7d7e80u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xdae3ebf2u, 0xb8c0c8d1u); }
        case 33u: { v = vec4<u32>(0x9ea3a9b0u, 0x8f929599u, 0x86888a8cu, 0x81828385u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xdde5edf3u, 0xbbc3cbd4u); }
        case 35u: { v = vec4<u32>(0xa3a8adb4u, 0x94979a9eu, 0x8b8d8f91u, 0x8687888au); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xf9fcfefeu, 0xe0e8eff5u, 0xbfc6cfd7u); }
        case 37u: { v = vec4<u32>(0xa8adb2b8u, 0x999ca0a4u, 0x90929497u, 0x8a8b8d8eu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe2eaf0f6u, 0xc4cbd2dau); }
        case 39u: { v = vec4<u32>(0xadb2b7bdu, 0x9fa2a5a9u, 0x9597999cu, 0x8e909193u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe5ecf2f6u, 0xc9d0d7deu); }
        case 41u: { v = vec4<u32>(0xb3b8bdc3u, 0xa4a7abafu, 0x9a9c9fa1u, 0x92949698u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe9eef3f7u, 0xcfd6dce3u); }
        case 43u: { v = vec4<u32>(0xb9bec3c9u, 0xaaadb1b5u, 0x9fa1a4a7u, 0x97999a9du); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfbfdfefeu, 0xedf2f5f9u, 0xd5dce2e8u); }
        case 45u: { v = vec4<u32>(0xbfc4cacfu, 0xafb3b7bbu, 0xa4a6a9acu, 0x9b9d9fa1u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xf1f5f8fbu, 0xdce1e7ecu); }
        case 47u: { v = vec4<u32>(0xc6cbd0d6u, 0xb5b9bdc1u, 0xa9acafb2u, 0xa0a2a4a6u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xe2e7ecf1u); }
        case 49u: { v = vec4<u32>(0xccd1d6dcu, 0xbbbfc3c7u, 0xaeb1b4b7u, 0xa5a7a9acu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafbfdu, 0xe7ecf0f4u); }
        case 51u: { v = vec4<u32>(0xd3d8dde2u, 0xc1c5c9ceu, 0xb4b7babeu, 0xaaacafb1u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xebf0f3f6u); }
        case 53u: { v = vec4<u32>(0xd9dee2e7u, 0xc8ccd0d4u, 0xbabdc0c4u, 0xafb2b4b7u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xf0f3f6f8u); }
        case 55u: { v = vec4<u32>(0xdfe4e8ecu, 0xcfd3d7dbu, 0xc0c4c7cbu, 0xb4b7babdu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf3f6f8fau); }
        case 57u: { v = vec4<u32>(0xe6e9edf0u, 0xd6dadee2u, 0xc6caced2u, 0xb9bcbfc3u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 59u: { v = vec4<u32>(0xebeef1f4u, 0xdce0e4e8u, 0xccd0d4d8u, 0xbcc0c4c8u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf9fafbfcu); }
        case 61u: { v = vec4<u32>(0xeff2f5f7u, 0xe1e5e9ecu, 0xd0d4d9ddu, 0xbcc1c6cbu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfefefeffu, 0xfafbfcfdu); }
        case 63u: { v = vec4<u32>(0xf3f5f7f9u, 0xe6eaedf0u, 0xd4d9dee2u, 0xbcc2c8ceu); }
        default: {}
      }
    }
    case 41u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfcfcfaffu, 0xeff3f7f9u, 0xd8dfe5eau, 0xb9c1c9d1u); }
        case 1u: { v = vec4<u32>(0x98a0a9b1u, 0x79818890u, 0x62676d73u, 0x5154585du); }
        case 2u: { v = vec4<u32>(0xf7f2e3ffu, 0xeef2f5f7u, 0xd8dee4e9u, 0xb9c1c9d1u); }
        case 3u: { v = vec4<u32>(0x98a0a8b1u, 0x79808890u, 0x61676c73u, 0x5054585cu); }
        case 4u: { v = vec4<u32>(0xeae3f6ffu, 0xeceff0efu, 0xd7dde3e8u, 0xb9c1c9d0u); }
        case 5u: { v = vec4<u32>(0x97a0a8b0u, 0x7980878fu, 0x61666c72u, 0x5054585cu); }
        case 6u: { v = vec4<u32>(0xe2ebfdffu, 0xe8e9e9e6u, 0xd6dce1e5u, 0xb8c0c8cfu); }
        case 7u: { v = vec4<u32>(0x979fa8b0u, 0x7980878fu, 0x61666c72u, 0x5054585cu); }
        case 8u: { v = vec4<u32>(0xe6f6feffu, 0xe4e4e3e1u, 0xd5dadfe2u, 0xb8c0c7ceu); }
        case 9u: { v = vec4<u32>(0x979fa7b0u, 0x787f878fu, 0x61666c72u, 0x5155585du); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe0e0e0e4u, 0xd3d8dcdfu, 0xb7bfc6cdu); }
        case 11u: { v = vec4<u32>(0x969fa7afu, 0x787f878eu, 0x62676c72u, 0x5356595du); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xdddee2eau, 0xd1d6d9dcu, 0xb7bec5ccu); }
        case 13u: { v = vec4<u32>(0x969ea6afu, 0x797f878eu, 0x63686d72u, 0x55585b5fu); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xdce0e7f0u, 0xd0d4d8dau, 0xb6bec5cbu); }
        case 15u: { v = vec4<u32>(0x969ea6aeu, 0x7980878eu, 0x64696e73u, 0x585a5d60u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xdee4ecf5u, 0xcfd3d7dau, 0xb6bdc4cau); }
        case 17u: { v = vec4<u32>(0x969ea6aeu, 0x7a80878fu, 0x666b6f74u, 0x5b5d6063u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe1e8f1f9u, 0xced3d7dbu, 0xb6bdc3c9u); }
        case 19u: { v = vec4<u32>(0x979ea6aeu, 0x7b81888fu, 0x696d7176u, 0x5f616366u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe5edf5fbu, 0xcfd4d9deu, 0xb6bdc3c9u); }
        case 21u: { v = vec4<u32>(0x979fa6aeu, 0x7d838990u, 0x6c6f7378u, 0x63656769u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xe9f1f8fcu, 0xd0d5dbe2u, 0xb6bdc4cau); }
        case 23u: { v = vec4<u32>(0x989fa7aeu, 0x7f848a91u, 0x6f72767au, 0x68696b6du); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xedf4fafdu, 0xd1d8dfe6u, 0xb6bec4cbu); }
        case 25u: { v = vec4<u32>(0x99a0a8afu, 0x81868c92u, 0x7376797du, 0x6c6d6f71u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf1f7fbfdu, 0xd4dbe2eau, 0xb7bfc6cdu); }
        case 27u: { v = vec4<u32>(0x9aa1a9b0u, 0x84898e94u, 0x777a7d80u, 0x71727375u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf4f9fcfeu, 0xd6dee6edu, 0xb9c0c8cfu); }
        case 29u: { v = vec4<u32>(0x9ca3aab1u, 0x878c9196u, 0x7b7e8084u, 0x75767879u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf6fafdfeu, 0xd9e1e9f0u, 0xbac2cad2u); }
        case 31u: { v = vec4<u32>(0x9ea5acb3u, 0x8b8f9399u, 0x80828487u, 0x7a7b7c7eu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xdde5ecf2u, 0xbcc4ccd4u); }
        case 33u: { v = vec4<u32>(0xa1a7aeb5u, 0x8f92979cu, 0x8486898bu, 0x7e7f8182u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xdfe7eef4u, 0xbfc6cfd7u); }
        case 35u: { v = vec4<u32>(0xa4aab0b7u, 0x93969b9fu, 0x888b8d90u, 0x82838587u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe2eaf0f6u, 0xc1c9d2dau); }
        case 37u: { v = vec4<u32>(0xa8adb3bau, 0x979b9fa3u, 0x8d8f9294u, 0x8688898bu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfafdfeffu, 0xe5ecf2f7u, 0xc5ccd4ddu); }
        case 39u: { v = vec4<u32>(0xacb1b7beu, 0x9c9fa3a7u, 0x91949699u, 0x8a8c8d8fu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xe7edf3f8u, 0xc9d0d8dfu); }
        case 41u: { v = vec4<u32>(0xb1b6bcc2u, 0xa1a4a8acu, 0x96989b9eu, 0x8e909294u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xe9eff4f8u, 0xced4dbe2u); }
        case 43u: { v = vec4<u32>(0xb6bbc1c7u, 0xa6a9adb1u, 0x9a9d9fa2u, 0x92949698u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xecf1f5f8u, 0xd3d9e0e6u); }
        case 45u: { v = vec4<u32>(0xbcc1c7cdu, 0xabaeb2b7u, 0x9fa1a4a7u, 0x96989a9cu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfbfdfefeu, 0xeff3f7f9u, 0xd9dfe5eau); }
        case 47u: { v = vec4<u32>(0xc1c7ccd2u, 0xb0b4b8bcu, 0xa3a6a9acu, 0x9a9c9ea1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf3f6f9fbu, 0xdee4e9eeu); }
        case 49u: { v = vec4<u32>(0xc7cdd3d8u, 0xb5b9bec2u, 0xa8abaeb1u, 0x9ea0a3a5u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfcu, 0xe4e9eef2u); }
        case 51u: { v = vec4<u32>(0xced3d9deu, 0xbbbfc3c8u, 0xadb0b3b7u, 0xa2a5a7aau); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe9edf1f5u); }
        case 53u: { v = vec4<u32>(0xd4d9dee4u, 0xc1c5cacfu, 0xb2b5b9bdu, 0xa7a9acafu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xedf1f4f7u); }
        case 55u: { v = vec4<u32>(0xdadfe4e9u, 0xc7cbd0d5u, 0xb7bbbec3u, 0xabadb0b4u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf0f4f6f9u); }
        case 57u: { v = vec4<u32>(0xe0e4e9edu, 0xcdd2d7dbu, 0xbcc0c4c9u, 0xaeb1b4b8u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfdfeu, 0xf4f6f8fau); }
        case 59u: { v = vec4<u32>(0xe5e9edf1u, 0xd3d8dde1u, 0xc0c5c9ceu, 0xaeb2b7bbu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf6f8fafbu); }
        case 61u: { v = vec4<u32>(0xebeef1f4u, 0xd9dee3e7u, 0xc4cacfd4u, 0xadb3b9bfu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfefefeu, 0xf9fafbfcu); }
        case 63u: { v = vec4<u32>(0xeff2f5f7u, 0xdfe4e8ecu, 0xc9cfd5dau, 0xadb5bcc2u); }
        default: {}
      }
    }
    case 42u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfcfdfaffu, 0xf1f5f8fau, 0xdee4e9edu, 0xc4cbd1d8u); }
        case 1u: { v = vec4<u32>(0xa6adb5bcu, 0x8990979eu, 0x71777c83u, 0x5f63686cu); }
        case 2u: { v = vec4<u32>(0xf7f2e3ffu, 0xf1f4f6f8u, 0xdee3e8edu, 0xc3cad1d8u); }
        case 3u: { v = vec4<u32>(0xa6adb5bcu, 0x8990979eu, 0x71767c82u, 0x5f63676cu); }
        case 4u: { v = vec4<u32>(0xeae3f6ffu, 0xeef0f1efu, 0xdde2e7ebu, 0xc3cad1d7u); }
        case 5u: { v = vec4<u32>(0xa5adb4bcu, 0x888f969eu, 0x70767b82u, 0x5e62676bu); }
        case 6u: { v = vec4<u32>(0xe2ebfdffu, 0xeaebeae6u, 0xdce1e5e8u, 0xc2c9d0d6u); }
        case 7u: { v = vec4<u32>(0xa4acb4bbu, 0x888e969du, 0x70757b81u, 0x5e62666bu); }
        case 8u: { v = vec4<u32>(0xe6f6feffu, 0xe6e5e3e2u, 0xdadfe2e5u, 0xc1c8cfd5u); }
        case 9u: { v = vec4<u32>(0xa4abb3bau, 0x878e959cu, 0x6f747a80u, 0x5e61666au); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe1e1e1e4u, 0xd8dcdfe1u, 0xc1c7ced3u); }
        case 11u: { v = vec4<u32>(0xa3abb2b9u, 0x868d949bu, 0x6f747a80u, 0x5e62666au); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xdedfe2eau, 0xd6dadcdeu, 0xc0c6ccd2u); }
        case 13u: { v = vec4<u32>(0xa2aab1b9u, 0x868d949bu, 0x6f747a7fu, 0x5f62666au); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xdde1e7f1u, 0xd4d8dadcu, 0xbfc5cbd0u); }
        case 15u: { v = vec4<u32>(0xa2a9b1b8u, 0x868c939au, 0x6f747a7fu, 0x6063676bu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xdfe4ecf5u, 0xd3d6d9dbu, 0xbec4cacfu); }
        case 17u: { v = vec4<u32>(0xa1a9b0b7u, 0x868c939au, 0x70757a7fu, 0x6265686cu); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe2e9f1f9u, 0xd2d6d9ddu, 0xbdc4c9ceu); }
        case 19u: { v = vec4<u32>(0xa1a8b0b7u, 0x868c939au, 0x71767b80u, 0x64676a6du); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe6edf5fbu, 0xd2d6dadfu, 0xbdc3c9cdu); }
        case 21u: { v = vec4<u32>(0xa1a8afb6u, 0x868c939au, 0x73777c81u, 0x67696c6fu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xeaf1f8fcu, 0xd3d7dde3u, 0xbdc3c8ceu); }
        case 23u: { v = vec4<u32>(0xa1a8afb6u, 0x878d939au, 0x75797d82u, 0x6a6c6f71u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xeef5fafdu, 0xd4dae0e7u, 0xbdc3c9cfu); }
        case 25u: { v = vec4<u32>(0xa1a8afb6u, 0x888e949bu, 0x777b7f83u, 0x6d6f7174u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf1f7fbfdu, 0xd6dce3eau, 0xbdc4cad0u); }
        case 27u: { v = vec4<u32>(0xa2a9b0b7u, 0x8a8f959bu, 0x7a7d8185u, 0x71737577u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf4f9fcfeu, 0xd9e0e7eeu, 0xbec5cbd2u); }
        case 29u: { v = vec4<u32>(0xa3a9b0b7u, 0x8c91969cu, 0x7d808387u, 0x7576787au); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf6fafdfeu, 0xdce3eaf1u, 0xbfc6cdd4u); }
        case 31u: { v = vec4<u32>(0xa4aab1b8u, 0x8e93989eu, 0x8083868au, 0x787a7c7eu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xdfe6edf3u, 0xc1c8d0d7u); }
        case 33u: { v = vec4<u32>(0xa5acb3bau, 0x91959aa0u, 0x8486898du, 0x7c7d7f81u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xf9fcfefeu, 0xe2e9eff5u, 0xc3cad2dau); }
        case 35u: { v = vec4<u32>(0xa7aeb4bbu, 0x94989da2u, 0x878a8d90u, 0x7f818385u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe4ebf1f6u, 0xc5cdd5ddu); }
        case 37u: { v = vec4<u32>(0xaab0b6bdu, 0x979b9fa4u, 0x8b8d9093u, 0x83858789u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xe7edf3f8u, 0xc7cfd7dfu); }
        case 39u: { v = vec4<u32>(0xadb3b9c0u, 0x9b9fa3a8u, 0x8f919497u, 0x87888a8cu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xe9eff4f8u, 0xcad2dae1u); }
        case 41u: { v = vec4<u32>(0xb0b6bcc3u, 0x9fa2a7abu, 0x9395989bu, 0x8a8c8e90u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xeaf0f5f9u, 0xced5dce4u); }
        case 43u: { v = vec4<u32>(0xb5bac0c7u, 0xa3a7abb0u, 0x96999c9fu, 0x8e909294u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xecf1f6f9u, 0xd2d9dfe6u); }
        case 45u: { v = vec4<u32>(0xb9bfc5cbu, 0xa7abafb4u, 0x9a9da0a4u, 0x91939598u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xeef3f6f9u, 0xd7dde3e9u); }
        case 47u: { v = vec4<u32>(0xbec4cad0u, 0xacb0b4b9u, 0x9ea1a4a8u, 0x9597999cu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf1f5f8fau, 0xdce2e7edu); }
        case 49u: { v = vec4<u32>(0xc4c9cfd6u, 0xb0b5b9beu, 0xa2a5a9acu, 0x989a9d9fu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xe1e7ecf0u); }
        case 51u: { v = vec4<u32>(0xc9cfd5dbu, 0xb5babfc4u, 0xa6aaadb1u, 0x9b9ea0a3u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xe6ebf0f4u); }
        case 53u: { v = vec4<u32>(0xcfd5dbe1u, 0xbabfc4cau, 0xaaaeb2b6u, 0x9ea1a4a7u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeaeff3f6u); }
        case 55u: { v = vec4<u32>(0xd5dbe0e6u, 0xc0c5cacfu, 0xaeb2b6bbu, 0xa1a4a7abu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeef2f5f8u); }
        case 57u: { v = vec4<u32>(0xdbe0e5eau, 0xc5cad0d5u, 0xb1b6bbc0u, 0xa1a5a9adu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf1f4f7f9u); }
        case 59u: { v = vec4<u32>(0xe0e5e9edu, 0xcad0d5dbu, 0xb4babfc5u, 0xa0a5aaafu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfcfdfefeu, 0xf4f7f9fau); }
        case 61u: { v = vec4<u32>(0xe5eaeef1u, 0xd1d6dce1u, 0xb8bec5cbu, 0x9fa5abb2u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfdfdfefeu, 0xf7f9fafcu); }
        case 63u: { v = vec4<u32>(0xebeff2f5u, 0xd8dde2e7u, 0xbdc4cbd2u, 0x9fa6aeb6u); }
        default: {}
      }
    }
    case 43u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfcfdfaffu, 0xf4f6f9fbu, 0xe3e8ecf0u, 0xccd3d8deu); }
        case 1u: { v = vec4<u32>(0xb2b9c0c6u, 0x989ea5abu, 0x81868c92u, 0x6e72777cu); }
        case 2u: { v = vec4<u32>(0xf7f2e3ffu, 0xf3f5f7f8u, 0xe3e7ecefu, 0xccd2d8deu); }
        case 3u: { v = vec4<u32>(0xb2b9bfc6u, 0x979ea4abu, 0x80868b91u, 0x6e72767bu); }
        case 4u: { v = vec4<u32>(0xebe3f6ffu, 0xf0f2f2f0u, 0xe2e6eaeeu, 0xccd2d7ddu); }
        case 5u: { v = vec4<u32>(0xb1b8bfc5u, 0x979da4aau, 0x7f858a90u, 0x6d71757au); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xececeae7u, 0xe0e5e8ebu, 0xcbd1d6dcu); }
        case 7u: { v = vec4<u32>(0xb0b7bec4u, 0x969ca3aau, 0x7e84898fu, 0x6c707479u); }
        case 8u: { v = vec4<u32>(0xe6f6feffu, 0xe7e6e4e2u, 0xdfe2e5e7u, 0xcad0d5dau); }
        case 9u: { v = vec4<u32>(0xafb6bdc3u, 0x949ba2a9u, 0x7d82888eu, 0x6b6f7378u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe3e2e1e4u, 0xdce0e2e3u, 0xc9ced4d8u); }
        case 11u: { v = vec4<u32>(0xaeb5bcc2u, 0x939aa1a7u, 0x7c81878du, 0x6a6e7277u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xdfe0e3eau, 0xdadddfdfu, 0xc7cdd2d7u); }
        case 13u: { v = vec4<u32>(0xadb4bbc1u, 0x9299a0a6u, 0x7b81868cu, 0x6a6d7276u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xdee1e7f1u, 0xd8dadcddu, 0xc6ccd0d5u); }
        case 15u: { v = vec4<u32>(0xacb3bac0u, 0x92989fa5u, 0x7b80858bu, 0x6a6d7176u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xdfe5edf5u, 0xd6d9dbddu, 0xc5cacfd3u); }
        case 17u: { v = vec4<u32>(0xabb2b9bfu, 0x91979ea5u, 0x7a7f858bu, 0x6a6e7176u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe2e9f1f9u, 0xd5d8dadeu, 0xc4c9ced2u); }
        case 19u: { v = vec4<u32>(0xabb1b8beu, 0x90979da4u, 0x7a7f858au, 0x6b6e7276u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe6eef5fbu, 0xd5d8dce0u, 0xc3c8cdd1u); }
        case 21u: { v = vec4<u32>(0xaab1b7bdu, 0x90969da3u, 0x7b7f858au, 0x6c6f7377u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xeaf2f8fcu, 0xd5d9dee4u, 0xc2c8ccd1u); }
        case 23u: { v = vec4<u32>(0xa9b0b7bdu, 0x90969ca3u, 0x7c80858au, 0x6e717478u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xeef5fafdu, 0xd6dbe1e7u, 0xc2c8cdd1u); }
        case 25u: { v = vec4<u32>(0xa9b0b6bcu, 0x90969ca3u, 0x7d81868bu, 0x70737679u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf2f7fbfdu, 0xd8dee4ebu, 0xc2c8cdd3u); }
        case 27u: { v = vec4<u32>(0xa9b0b6bcu, 0x91969ca3u, 0x7e82878bu, 0x7375787bu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf4f9fcfeu, 0xdae1e8eeu, 0xc3c9cfd4u); }
        case 29u: { v = vec4<u32>(0xa9b0b6bdu, 0x91979da3u, 0x8084888cu, 0x75787a7du); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf6fafdfeu, 0xdde4ebf1u, 0xc4cad0d7u); }
        case 31u: { v = vec4<u32>(0xaab0b7bdu, 0x93989da3u, 0x82868a8eu, 0x787a7c7fu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xe0e7eef3u, 0xc5cbd2d9u); }
        case 33u: { v = vec4<u32>(0xaab1b7beu, 0x94999fa4u, 0x85888c90u, 0x7b7d7f82u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xf9fcfefeu, 0xe3eaf0f5u, 0xc6cdd5dcu); }
        case 35u: { v = vec4<u32>(0xacb2b8bfu, 0x969ba0a6u, 0x878a8e92u, 0x7e808285u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfafdfeffu, 0xe6ecf2f7u, 0xc8d0d7dfu); }
        case 37u: { v = vec4<u32>(0xadb3bac1u, 0x989da2a7u, 0x8a8d9094u, 0x81838587u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xe8eff4f8u, 0xcad2dae1u); }
        case 39u: { v = vec4<u32>(0xafb5bcc3u, 0x9b9fa4a9u, 0x8d909397u, 0x8486888au); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xeaf0f5f9u, 0xcdd4dce3u); }
        case 41u: { v = vec4<u32>(0xb1b7bec5u, 0x9ea2a7acu, 0x9093969au, 0x87898b8eu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xecf2f6fau, 0xcfd7dee5u); }
        case 43u: { v = vec4<u32>(0xb4bac1c8u, 0xa1a5aaafu, 0x93969a9du, 0x8a8c8e91u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xedf3f7fau, 0xd2d9e1e7u); }
        case 45u: { v = vec4<u32>(0xb8bec4cbu, 0xa5a9aeb3u, 0x979a9da1u, 0x8d8f9194u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff3f7fau, 0xd6dde3e9u); }
        case 47u: { v = vec4<u32>(0xbcc2c9cfu, 0xa8adb2b7u, 0x9a9da1a4u, 0x8f929497u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf0f4f7fau, 0xdae0e6ecu); }
        case 49u: { v = vec4<u32>(0xc1c7cdd4u, 0xacb1b6bbu, 0x9da1a4a8u, 0x9295979au); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf3f6f9fbu, 0xdfe5eaefu); }
        case 51u: { v = vec4<u32>(0xc6ccd2d9u, 0xb0b5bbc0u, 0xa0a4a8acu, 0x95979a9du); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f9fbfcu, 0xe4e9eef2u); }
        case 53u: { v = vec4<u32>(0xcbd1d8deu, 0xb5babfc5u, 0xa3a7abb0u, 0x96999ca0u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe8edf1f5u); }
        case 55u: { v = vec4<u32>(0xd1d7dde3u, 0xb9bfc4cau, 0xa6aaafb4u, 0x979a9ea2u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xecf0f4f7u); }
        case 57u: { v = vec4<u32>(0xd6dce2e7u, 0xbdc3c9d0u, 0xa7acb2b7u, 0x95999ea2u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeff3f6f8u); }
        case 59u: { v = vec4<u32>(0xdbe1e6ebu, 0xc2c8cfd5u, 0xa9afb5bcu, 0x93989ea3u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf2f5f7fau); }
        case 61u: { v = vec4<u32>(0xe0e5eaeeu, 0xc8ced5dbu, 0xacb3bac1u, 0x91979ea5u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xfcfdfefeu, 0xf5f7f9fbu); }
        case 63u: { v = vec4<u32>(0xe6ebeff2u, 0xcfd6dce1u, 0xb1b9c1c8u, 0x9098a0a9u); }
        default: {}
      }
    }
    case 44u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfdfdfaffu, 0xf5f8fafcu, 0xe7ebeff2u, 0xd4d9dee3u); }
        case 1u: { v = vec4<u32>(0xbdc3c9cfu, 0xa5abb1b7u, 0x8f949a9fu, 0x7d81868au); }
        case 2u: { v = vec4<u32>(0xf8f2e3ffu, 0xf4f7f8f9u, 0xe7ebeff2u, 0xd4d9dee3u); }
        case 3u: { v = vec4<u32>(0xbdc3c9ceu, 0xa5abb1b7u, 0x8f94999fu, 0x7d81858au); }
        case 4u: { v = vec4<u32>(0xebe3f6ffu, 0xf2f3f3f0u, 0xe6eaedf0u, 0xd3d8dde2u); }
        case 5u: { v = vec4<u32>(0xbcc2c8ceu, 0xa4aab0b6u, 0x8e93989eu, 0x7b7f8489u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xeeedebe7u, 0xe4e8ebedu, 0xd2d7dce1u); }
        case 7u: { v = vec4<u32>(0xbbc1c7cdu, 0xa3a9afb5u, 0x8c91979du, 0x7a7e8287u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xe9e7e4e2u, 0xe2e5e7e9u, 0xd1d6dbdfu); }
        case 9u: { v = vec4<u32>(0xbac0c6cbu, 0xa1a7adb4u, 0x8b90959bu, 0x787c8185u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe4e2e1e4u, 0xe0e2e4e4u, 0xcfd4d9ddu); }
        case 11u: { v = vec4<u32>(0xb8bfc4cau, 0xa0a6acb2u, 0x898e949au, 0x767b7f84u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe0e0e3eau, 0xdddfe1e1u, 0xced3d7dbu); }
        case 13u: { v = vec4<u32>(0xb7bdc3c9u, 0x9ea4abb1u, 0x878d9298u, 0x75797e82u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xdfe1e7f1u, 0xdbdddedeu, 0xccd1d5d8u); }
        case 15u: { v = vec4<u32>(0xb6bcc2c7u, 0x9da3a9afu, 0x868b9197u, 0x74787c81u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe0e5edf6u, 0xd9dbdcdeu, 0xcbcfd3d6u); }
        case 17u: { v = vec4<u32>(0xb4bbc0c6u, 0x9ba2a8aeu, 0x858a9095u, 0x73777c80u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe3e9f2f9u, 0xd7dadcdfu, 0xcaced2d5u); }
        case 19u: { v = vec4<u32>(0xb3b9bfc5u, 0x9aa0a7adu, 0x84898f94u, 0x73777b7fu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe7eef5fbu, 0xd7d9dde1u, 0xc8cdd1d4u); }
        case 21u: { v = vec4<u32>(0xb2b8bec3u, 0x999fa6acu, 0x84888e93u, 0x73777b7fu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xebf2f8fcu, 0xd7dadfe4u, 0xc7ccd0d3u); }
        case 23u: { v = vec4<u32>(0xb1b7bdc2u, 0x999fa5abu, 0x83888d93u, 0x74777b7fu); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xeff5fafdu, 0xd8dce2e8u, 0xc7cbd0d4u); }
        case 25u: { v = vec4<u32>(0xb0b6bcc2u, 0x989ea4aau, 0x83888d92u, 0x75787b7fu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf2f7fbfeu, 0xdadfe5ebu, 0xc6cbd0d5u); }
        case 27u: { v = vec4<u32>(0xb0b6bcc1u, 0x989da3aau, 0x84888d92u, 0x76797c80u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf4f9fcfeu, 0xdce2e8efu, 0xc7ccd1d6u); }
        case 29u: { v = vec4<u32>(0xafb5bbc1u, 0x989da3a9u, 0x84898d92u, 0x787a7d81u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xdfe5ebf1u, 0xc7cdd3d9u); }
        case 31u: { v = vec4<u32>(0xafb5bbc1u, 0x989da3a9u, 0x868a8e93u, 0x797c7f82u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xe1e8eef4u, 0xc8ced5dbu); }
        case 33u: { v = vec4<u32>(0xafb6bcc2u, 0x989ea3a9u, 0x878b8f94u, 0x7b7e8084u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xf9fcfefeu, 0xe4ebf1f6u, 0xcad0d7deu); }
        case 35u: { v = vec4<u32>(0xb0b6bcc3u, 0x999fa4aau, 0x898c9095u, 0x7d808285u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfafdfeffu, 0xe7edf3f7u, 0xcbd2d9e0u); }
        case 37u: { v = vec4<u32>(0xb1b7bdc4u, 0x9ba0a5abu, 0x8b8e9296u, 0x80828587u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xe9eff4f8u, 0xcdd4dce3u); }
        case 39u: { v = vec4<u32>(0xb2b8bfc6u, 0x9ca1a6acu, 0x8d909498u, 0x8284878au); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xecf1f6f9u, 0xcfd6dee5u); }
        case 41u: { v = vec4<u32>(0xb3bac1c8u, 0x9ea3a8adu, 0x8f92969au, 0x8487898cu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xedf3f7fau, 0xd1d9e0e7u); }
        case 43u: { v = vec4<u32>(0xb5bcc3cau, 0xa0a5aab0u, 0x9195989cu, 0x87898c8eu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f8fbu, 0xd4dbe2e9u); }
        case 45u: { v = vec4<u32>(0xb8bec5ccu, 0xa3a8adb2u, 0x94979b9fu, 0x898b8e91u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf0f4f8fbu, 0xd6dde4eau); }
        case 47u: { v = vec4<u32>(0xbbc2c8cfu, 0xa6abb0b5u, 0x969a9ea2u, 0x8b8d9093u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f8fbu, 0xd9e0e6ecu); }
        case 49u: { v = vec4<u32>(0xbfc5ccd3u, 0xa9aeb3b9u, 0x999ca0a5u, 0x8d8f9295u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf2f6f8fbu, 0xdde3e9eeu); }
        case 51u: { v = vec4<u32>(0xc3cad0d7u, 0xacb2b7bdu, 0x9b9fa3a8u, 0x8e919497u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf4f7fafcu, 0xe2e7ecf1u); }
        case 53u: { v = vec4<u32>(0xc8cfd5dbu, 0xb0b5bbc2u, 0x9da1a6abu, 0x8e919599u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafbfdu, 0xe6ebf0f4u); }
        case 55u: { v = vec4<u32>(0xcdd3dae0u, 0xb3b9bfc6u, 0x9da2a8adu, 0x8c909499u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xeaeff3f6u); }
        case 57u: { v = vec4<u32>(0xd2d8dfe5u, 0xb6bdc4cbu, 0x9ea4aab0u, 0x898e9398u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xedf1f5f8u); }
        case 59u: { v = vec4<u32>(0xd7dde3e9u, 0xbbc2c9d0u, 0x9fa6adb4u, 0x878c9299u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf0f4f7f9u); }
        case 61u: { v = vec4<u32>(0xdce2e7ecu, 0xc0c7ced5u, 0xa1a9b0b8u, 0x848b9299u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfdfdfeu, 0xf3f6f8fau); }
        case 63u: { v = vec4<u32>(0xe1e7ebefu, 0xc6ced5dbu, 0xa4adb6beu, 0x818a939cu); }
        default: {}
      }
    }
    case 45u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfdfdfaffu, 0xf7f9fbfcu, 0xebeff2f4u, 0xdbdfe3e7u); }
        case 1u: { v = vec4<u32>(0xc7ccd1d6u, 0xb2b7bcc2u, 0x9da2a7acu, 0x8c909499u); }
        case 2u: { v = vec4<u32>(0xf8f2e3ffu, 0xf6f8f9f9u, 0xebeef1f4u, 0xdadfe3e7u); }
        case 3u: { v = vec4<u32>(0xc7ccd1d6u, 0xb1b6bcc1u, 0x9da2a7acu, 0x8b8f9398u); }
        case 4u: { v = vec4<u32>(0xebe3f6ffu, 0xf3f4f3f1u, 0xeaedeff2u, 0xdadee2e6u); }
        case 5u: { v = vec4<u32>(0xc6cbd0d5u, 0xb0b5bbc0u, 0x9ba0a5abu, 0x898e9296u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xefeeece7u, 0xe8ebedeeu, 0xd8dde1e5u); }
        case 7u: { v = vec4<u32>(0xc4cacfd4u, 0xafb4babfu, 0x999fa4a9u, 0x878c9095u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xeae8e5e2u, 0xe6e8eaeau, 0xd7dbdfe3u); }
        case 9u: { v = vec4<u32>(0xc3c8cdd2u, 0xadb2b8beu, 0x979da2a7u, 0x85898e93u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe5e3e2e4u, 0xe3e5e6e6u, 0xd5dadde1u); }
        case 11u: { v = vec4<u32>(0xc1c7ccd1u, 0xabb1b6bcu, 0x959ba0a5u, 0x83878c90u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe1e1e3ebu, 0xe0e2e2e2u, 0xd4d8dbdeu); }
        case 13u: { v = vec4<u32>(0xc0c5cacfu, 0xa9afb5bau, 0x93999ea3u, 0x81858a8eu); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe0e2e8f1u, 0xdedfdfdfu, 0xd2d6d9dcu); }
        case 15u: { v = vec4<u32>(0xbec4c9cdu, 0xa7adb3b8u, 0x91979ca2u, 0x7f83888cu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe1e5edf6u, 0xdbdcdddeu, 0xd0d4d7d9u); }
        case 17u: { v = vec4<u32>(0xbcc2c7ccu, 0xa5abb1b7u, 0x8f959aa0u, 0x7d81868au); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe3eaf2f9u, 0xd9dbdddfu, 0xced2d5d8u); }
        case 19u: { v = vec4<u32>(0xbbc0c5cau, 0xa4aaafb5u, 0x8e93989eu, 0x7c808489u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe7eef5fbu, 0xd9dbdee1u, 0xcdd0d4d6u); }
        case 21u: { v = vec4<u32>(0xb9bfc4c9u, 0xa2a8aeb4u, 0x8c92979cu, 0x7b7f8388u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xebf2f8fcu, 0xd8dce0e5u, 0xcccfd3d6u); }
        case 23u: { v = vec4<u32>(0xb8bdc3c7u, 0xa1a7acb2u, 0x8b90969bu, 0x7a7e8287u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xeff5fafdu, 0xd9dde2e8u, 0xcbcfd2d6u); }
        case 25u: { v = vec4<u32>(0xb7bcc1c6u, 0xa0a5abb1u, 0x8a8f959au, 0x7a7e8286u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf2f7fbfeu, 0xdbe0e5ecu, 0xcaced2d7u); }
        case 27u: { v = vec4<u32>(0xb6bbc1c6u, 0x9fa4aab0u, 0x8a8f9499u, 0x7a7e8185u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xdde3e9efu, 0xcacfd3d8u); }
        case 29u: { v = vec4<u32>(0xb5bbc0c5u, 0x9ea4a9afu, 0x8a8e9398u, 0x7b7e8285u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fafdfeu, 0xe0e6ecf2u, 0xcacfd5dau); }
        case 31u: { v = vec4<u32>(0xb4bac0c5u, 0x9da3a9afu, 0x8a8e9398u, 0x7c7f8286u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf8fbfdfeu, 0xe2e9eff4u, 0xcbd1d6dcu); }
        case 33u: { v = vec4<u32>(0xb4bac0c5u, 0x9da3a8aeu, 0x8a8e9398u, 0x7d808386u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe5ebf1f6u, 0xccd2d9dfu); }
        case 35u: { v = vec4<u32>(0xb4bac0c6u, 0x9da3a8aeu, 0x8b8f9398u, 0x7e818487u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xe8eef3f7u, 0xced4dbe1u); }
        case 37u: { v = vec4<u32>(0xb4bbc1c7u, 0x9ea3a9aeu, 0x8c909499u, 0x7f828588u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xeaf0f5f9u, 0xcfd6dde4u); }
        case 39u: { v = vec4<u32>(0xb5bbc2c9u, 0x9ea4a9afu, 0x8d91959au, 0x8183868au); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xecf2f6fau, 0xd1d8e0e6u); }
        case 41u: { v = vec4<u32>(0xb6bcc3cau, 0x9fa4aab0u, 0x8f92969bu, 0x8285888bu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeef3f7fau, 0xd3dbe2e8u); }
        case 43u: { v = vec4<u32>(0xb7bec5ccu, 0xa1a6abb1u, 0x9094989cu, 0x84878a8du); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf0f4f8fbu, 0xd5dde4eau); }
        case 45u: { v = vec4<u32>(0xb9c0c7ceu, 0xa2a7adb3u, 0x9295999eu, 0x85888b8eu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xd7dfe5ecu); }
        case 47u: { v = vec4<u32>(0xbbc2c9d0u, 0xa4aaafb5u, 0x93979ba0u, 0x87898d90u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf2f6f9fbu, 0xdae1e7edu); }
        case 49u: { v = vec4<u32>(0xbec5ccd3u, 0xa7acb2b8u, 0x95999da2u, 0x878a8e91u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf2f6f9fbu, 0xdde3e9eeu); }
        case 51u: { v = vec4<u32>(0xc2c8cfd6u, 0xa9afb5bbu, 0x969a9fa4u, 0x878b8e92u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xf4f7f9fbu, 0xe0e6ebf0u); }
        case 53u: { v = vec4<u32>(0xc5ccd3dau, 0xabb1b8bfu, 0x969ba0a6u, 0x86898d92u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f9fbfcu, 0xe4eaeef2u); }
        case 55u: { v = vec4<u32>(0xc9d0d7deu, 0xaeb4bbc2u, 0x969ba1a7u, 0x82878c91u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe8edf2f5u); }
        case 57u: { v = vec4<u32>(0xced5dce2u, 0xb1b8bfc7u, 0x969ca3a9u, 0x7f848a90u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xecf0f4f7u); }
        case 59u: { v = vec4<u32>(0xd3dae0e6u, 0xb4bcc4cbu, 0x969da5acu, 0x7c82888fu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeff2f6f8u); }
        case 61u: { v = vec4<u32>(0xd8dee4eau, 0xb8c1c9d0u, 0x979fa8b0u, 0x7880878fu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfbfcfdfeu, 0xf0f4f7f9u); }
        case 63u: { v = vec4<u32>(0xdce2e8ecu, 0xbdc5cdd5u, 0x98a1abb4u, 0x747d868fu); }
        default: {}
      }
    }
    case 46u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfdfdfaffu, 0xf8fafbfcu, 0xeef1f4f6u, 0xe1e4e8ebu); }
        case 1u: { v = vec4<u32>(0xcfd4d8ddu, 0xbdc2c6cbu, 0xaaafb3b8u, 0x9a9ea2a6u); }
        case 2u: { v = vec4<u32>(0xf8f2e3ffu, 0xf7f9fafau, 0xeef1f3f5u, 0xe0e4e8ebu); }
        case 3u: { v = vec4<u32>(0xcfd4d8dcu, 0xbcc1c6cbu, 0xaaaeb3b8u, 0x999da1a5u); }
        case 4u: { v = vec4<u32>(0xebe3f6ffu, 0xf4f5f4f1u, 0xedeff2f3u, 0xdfe3e7eau); }
        case 5u: { v = vec4<u32>(0xced3d7dbu, 0xbbc0c5c9u, 0xa8adb1b6u, 0x979b9fa4u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf0efece7u, 0xebedeff0u, 0xdee2e5e8u); }
        case 7u: { v = vec4<u32>(0xcdd1d6dau, 0xb9bec3c8u, 0xa6abb0b4u, 0x95999da1u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xebe8e5e3u, 0xe9eaebecu, 0xdce0e3e6u); }
        case 9u: { v = vec4<u32>(0xcbd0d4d8u, 0xb7bcc1c6u, 0xa4a8adb2u, 0x92969a9fu); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe6e3e2e5u, 0xe6e7e7e7u, 0xdbdee1e4u); }
        case 11u: { v = vec4<u32>(0xc9ced3d7u, 0xb5babfc4u, 0xa1a6abb0u, 0x8f93989cu); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe2e1e3ebu, 0xe3e4e4e3u, 0xd9dcdfe1u); }
        case 13u: { v = vec4<u32>(0xc7ccd1d5u, 0xb3b8bdc3u, 0x9fa4a9aeu, 0x8c91959au); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe0e2e8f1u, 0xe0e0e0e0u, 0xd7dadcdeu); }
        case 15u: { v = vec4<u32>(0xc5cacfd3u, 0xb1b6bbc1u, 0x9ca1a6acu, 0x8a8e9297u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe1e6edf6u, 0xdddededfu, 0xd4d8dadcu); }
        case 17u: { v = vec4<u32>(0xc4c8cdd1u, 0xafb4b9beu, 0x9a9fa4a9u, 0x878b9095u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe4eaf2f9u, 0xdbdcdee0u, 0xd2d5d8dau); }
        case 19u: { v = vec4<u32>(0xc2c6cbcfu, 0xacb2b7bdu, 0x979ca2a7u, 0x85898e92u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe7eef5fbu, 0xdadcdee2u, 0xd1d4d6d8u); }
        case 21u: { v = vec4<u32>(0xc0c5c9cdu, 0xaab0b5bbu, 0x959aa0a5u, 0x83878c90u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xebf2f8fcu, 0xdadde0e5u, 0xcfd2d5d7u); }
        case 23u: { v = vec4<u32>(0xbec3c7ccu, 0xa9aeb4b9u, 0x93989ea3u, 0x81858a8eu); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xeff5fafdu, 0xdbdee3e9u, 0xced1d4d7u); }
        case 25u: { v = vec4<u32>(0xbcc1c6cau, 0xa7acb2b7u, 0x92979ca1u, 0x8084888du); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf2f8fbfeu, 0xdce1e6ecu, 0xcdd1d4d8u); }
        case 27u: { v = vec4<u32>(0xbbc0c5c9u, 0xa5abb0b6u, 0x90959aa0u, 0x7f83878cu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xdee3e9efu, 0xcdd1d5d9u); }
        case 29u: { v = vec4<u32>(0xbabfc4c9u, 0xa4aaafb5u, 0x8f94999fu, 0x7f82868bu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe1e6ecf2u, 0xcdd2d6dbu); }
        case 31u: { v = vec4<u32>(0xb9bec3c8u, 0xa3a8aeb4u, 0x8f93989du, 0x7f82868au); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf8fcfdfeu, 0xe3e9eff4u, 0xced3d8ddu); }
        case 33u: { v = vec4<u32>(0xb8bec3c8u, 0xa2a8adb3u, 0x8e93989du, 0x7f82868au); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe6ecf1f6u, 0xcfd4dae0u); }
        case 35u: { v = vec4<u32>(0xb8bec3c9u, 0xa1a7adb2u, 0x8e92979cu, 0x7f82868au); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xe9eef3f8u, 0xd0d6dce2u); }
        case 37u: { v = vec4<u32>(0xb8bec4cau, 0xa1a7acb2u, 0x8e92979cu, 0x8083868au); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf1f5f9u, 0xd1d8dfe5u); }
        case 39u: { v = vec4<u32>(0xb8bec5cbu, 0xa1a6acb2u, 0x8e92979cu, 0x8083878au); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f7fau, 0xd3dae1e7u); }
        case 41u: { v = vec4<u32>(0xb8bfc6ccu, 0xa1a7acb2u, 0x8f93979cu, 0x8184878bu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f8fau, 0xd5dce3e9u); }
        case 43u: { v = vec4<u32>(0xb9c0c7ceu, 0xa2a7adb3u, 0x8f94989du, 0x8285888cu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xd7dee5ebu); }
        case 45u: { v = vec4<u32>(0xbac1c8d0u, 0xa3a8aeb4u, 0x9094999du, 0x8285898cu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf2f6f9fbu, 0xd9e0e7edu); }
        case 47u: { v = vec4<u32>(0xbcc3cad1u, 0xa4a9afb5u, 0x91959a9eu, 0x8386898du); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdbe2e8eeu); }
        case 49u: { v = vec4<u32>(0xbec5ccd4u, 0xa5abb1b7u, 0x91969ba0u, 0x8286898du); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdde3e9efu); }
        case 51u: { v = vec4<u32>(0xc0c8cfd6u, 0xa6acb3bau, 0x91969ba1u, 0x8185888du); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xdfe5ebf0u); }
        case 53u: { v = vec4<u32>(0xc3cbd2d9u, 0xa8aeb5bcu, 0x90969ba1u, 0x7d82868bu); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f8fafcu, 0xe3e8edf1u); }
        case 55u: { v = vec4<u32>(0xc7ced5dcu, 0xa9b0b8bfu, 0x8f959ca2u, 0x7a7f8489u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe6ecf0f4u); }
        case 57u: { v = vec4<u32>(0xcbd3dae0u, 0xacb3bbc3u, 0x8f969da4u, 0x767c8288u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xeaeff3f6u); }
        case 59u: { v = vec4<u32>(0xd0d7dee5u, 0xafb7bfc8u, 0x8e969ea6u, 0x72798087u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xedf1f5f8u); }
        case 61u: { v = vec4<u32>(0xd4dbe2e8u, 0xb2bbc4ccu, 0x8e97a0a9u, 0x6e767e86u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeff3f6f9u); }
        case 63u: { v = vec4<u32>(0xd8dfe5eau, 0xb5bfc8d0u, 0x8e98a2acu, 0x69727b84u); }
        default: {}
      }
    }
    case 47u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfdfdfaffu, 0xf9fbfcfdu, 0xf1f4f6f8u, 0xe6e9ecefu); }
        case 1u: { v = vec4<u32>(0xd7dbdfe2u, 0xc7cbcfd3u, 0xb7bbbfc3u, 0xa7abafb3u); }
        case 2u: { v = vec4<u32>(0xf8f3e3ffu, 0xf8f9fafau, 0xf1f3f5f7u, 0xe5e8ebeeu); }
        case 3u: { v = vec4<u32>(0xd7dbdee2u, 0xc6cbcfd3u, 0xb6babec2u, 0xa6aaaeb2u); }
        case 4u: { v = vec4<u32>(0xebe3f6ffu, 0xf5f5f4f1u, 0xeff2f3f5u, 0xe4e7eaedu); }
        case 5u: { v = vec4<u32>(0xd6dadde1u, 0xc5c9cdd2u, 0xb4b8bcc1u, 0xa4a8acb0u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf1f0ede8u, 0xedeff0f1u, 0xe3e6e9ebu); }
        case 7u: { v = vec4<u32>(0xd4d8dcdfu, 0xc3c8ccd0u, 0xb2b6babfu, 0xa1a5a9adu); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xebe9e5e3u, 0xebecededu, 0xe1e4e7e9u); }
        case 9u: { v = vec4<u32>(0xd2d6dadeu, 0xc1c5caceu, 0xafb3b8bcu, 0x9ea2a6abu); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe6e4e2e5u, 0xe8e9e9e8u, 0xdfe2e4e7u); }
        case 11u: { v = vec4<u32>(0xd0d4d8dcu, 0xbfc3c8ccu, 0xacb1b5bau, 0x9b9fa3a8u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe2e2e3ebu, 0xe5e5e5e4u, 0xdde0e2e4u); }
        case 13u: { v = vec4<u32>(0xced2d6dau, 0xbcc1c5cau, 0xa9aeb3b7u, 0x979ca0a4u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe1e2e8f1u, 0xe2e2e2e1u, 0xdbdddfe1u); }
        case 15u: { v = vec4<u32>(0xccd0d4d7u, 0xb9bec3c8u, 0xa6abb0b5u, 0x94989da1u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe1e6edf6u, 0xdfdfdfe0u, 0xd8dbdddeu); }
        case 17u: { v = vec4<u32>(0xcaced2d5u, 0xb7bcc1c5u, 0xa3a8adb2u, 0x91959a9eu); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe4eaf2f9u, 0xdddddee0u, 0xd6d8dadcu); }
        case 19u: { v = vec4<u32>(0xc8ccd0d3u, 0xb4b9bec3u, 0xa0a5aaafu, 0x8e92979bu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe8eef6fbu, 0xdbdddfe2u, 0xd4d6d8dau); }
        case 21u: { v = vec4<u32>(0xc5caced1u, 0xb2b7bcc1u, 0x9ea3a8adu, 0x8b8f9499u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xebf2f8fcu, 0xdbdde1e5u, 0xd2d5d7d9u); }
        case 23u: { v = vec4<u32>(0xc3c8cccfu, 0xb0b5babfu, 0x9ba0a5aau, 0x898d9196u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xeff5fafdu, 0xdcdfe3e9u, 0xd1d4d6d9u); }
        case 25u: { v = vec4<u32>(0xc1c6caceu, 0xadb3b8bdu, 0x999ea3a8u, 0x878b8f94u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf2f8fbfeu, 0xdde1e6ecu, 0xd0d3d6d9u); }
        case 27u: { v = vec4<u32>(0xc0c4c8ccu, 0xabb1b6bbu, 0x979ca1a6u, 0x85898d92u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xdfe4eaefu, 0xcfd3d7dau); }
        case 29u: { v = vec4<u32>(0xbec3c7cbu, 0xaaafb4b9u, 0x959a9fa4u, 0x83878c90u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe1e7edf2u, 0xcfd3d8dcu); }
        case 31u: { v = vec4<u32>(0xbdc2c7cbu, 0xa8adb3b8u, 0x93989da3u, 0x82868a8fu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe4eaeff4u, 0xd0d4d9deu); }
        case 33u: { v = vec4<u32>(0xbcc1c6cbu, 0xa7acb2b7u, 0x92979ca1u, 0x8185898eu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfefeu, 0xe7ecf2f6u, 0xd0d6dbe1u); }
        case 35u: { v = vec4<u32>(0xbbc1c6cbu, 0xa6abb1b6u, 0x91969ba0u, 0x8185888du); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xe9eff4f8u, 0xd2d7dde3u); }
        case 37u: { v = vec4<u32>(0xbbc1c6ccu, 0xa5aab0b5u, 0x90959a9fu, 0x8184888cu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xecf1f5f9u, 0xd3d9e0e6u); }
        case 39u: { v = vec4<u32>(0xbbc1c7cdu, 0xa4a9afb5u, 0x9095999fu, 0x8084888cu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xeef3f7fau, 0xd5dbe2e8u); }
        case 41u: { v = vec4<u32>(0xbbc1c8ceu, 0xa3a9afb5u, 0x9094999eu, 0x8084878bu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf0f4f8fbu, 0xd7dde4eau); }
        case 43u: { v = vec4<u32>(0xbbc2c9d0u, 0xa3a9afb5u, 0x8f94999eu, 0x8084878bu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xd8dfe6ecu); }
        case 45u: { v = vec4<u32>(0xbcc3cad1u, 0xa3a9afb5u, 0x8f94999eu, 0x8083878bu); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf2f6f9fcu, 0xdae1e8edu); }
        case 47u: { v = vec4<u32>(0xbdc4cbd3u, 0xa3a9b0b6u, 0x8f94989eu, 0x7f83868bu); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdce3e9efu); }
        case 49u: { v = vec4<u32>(0xbec6cdd5u, 0xa4aab0b7u, 0x8e93989eu, 0x7d81858au); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xdde4eaf0u); }
        case 51u: { v = vec4<u32>(0xc0c7cfd6u, 0xa4abb1b9u, 0x8d92989eu, 0x7a7e8388u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xdfe6ebf0u); }
        case 53u: { v = vec4<u32>(0xc2cad1d8u, 0xa5acb3bau, 0x8b91979eu, 0x767b8085u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf5f8fafcu, 0xe2e8edf1u); }
        case 55u: { v = vec4<u32>(0xc5cdd4dbu, 0xa6adb5bdu, 0x8a90979eu, 0x72787d83u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f9fbfcu, 0xe5ebeff3u); }
        case 57u: { v = vec4<u32>(0xc9d0d8dfu, 0xa8b0b8c0u, 0x899098a0u, 0x6e747b82u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xe9eef2f6u); }
        case 59u: { v = vec4<u32>(0xcdd5dce3u, 0xaab3bcc4u, 0x889098a1u, 0x6a717880u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xecf1f4f7u); }
        case 61u: { v = vec4<u32>(0xd1d9e0e7u, 0xadb6c0c9u, 0x87909aa3u, 0x666d767eu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeef2f6f8u); }
        case 63u: { v = vec4<u32>(0xd5dde3e9u, 0xb0bac4cdu, 0x86909ba5u, 0x6169737cu); }
        default: {}
      }
    }
    case 48u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefdfaffu, 0xfafbfcfdu, 0xf4f5f7f9u, 0xeaedeff1u); }
        case 1u: { v = vec4<u32>(0xdee1e4e7u, 0xd0d4d7dbu, 0xc2c5c9ccu, 0xb4b7bbbeu); }
        case 2u: { v = vec4<u32>(0xf8f3e3ffu, 0xf9fafbfau, 0xf3f5f7f8u, 0xeaeceff1u); }
        case 3u: { v = vec4<u32>(0xdde1e4e7u, 0xcfd3d7dau, 0xc1c5c8ccu, 0xb3b6babdu); }
        case 4u: { v = vec4<u32>(0xebe3f6ffu, 0xf6f6f5f2u, 0xf2f3f5f6u, 0xe9ebeef0u); }
        case 5u: { v = vec4<u32>(0xdce0e3e6u, 0xced2d5d9u, 0xbfc3c7cau, 0xb1b4b8bbu); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf2f0ede8u, 0xf0f1f2f2u, 0xe7eaeceeu); }
        case 7u: { v = vec4<u32>(0xdbdee1e4u, 0xccd0d3d7u, 0xbcc0c4c8u, 0xadb1b5b9u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xece9e6e3u, 0xedeeeeeeu, 0xe5e8eaecu); }
        case 9u: { v = vec4<u32>(0xd9dcdfe2u, 0xcacdd1d5u, 0xb9bdc2c6u, 0xaaaeb1b5u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe7e4e2e5u, 0xeaeaeae9u, 0xe3e5e7e9u); }
        case 11u: { v = vec4<u32>(0xd6dadde0u, 0xc7cbcfd3u, 0xb6babfc3u, 0xa6aaaeb2u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe3e2e4ebu, 0xe7e7e6e5u, 0xe1e3e5e6u); }
        case 13u: { v = vec4<u32>(0xd4d8dbdeu, 0xc4c8ccd0u, 0xb3b7bbc0u, 0xa2a6aaaeu); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe1e3e8f1u, 0xe3e3e2e2u, 0xdee0e2e3u); }
        case 15u: { v = vec4<u32>(0xd2d5d9dcu, 0xc1c6caceu, 0xafb4b8bdu, 0x9ea2a7abu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe2e6edf6u, 0xe0e0e0e0u, 0xdcdedfe0u); }
        case 17u: { v = vec4<u32>(0xcfd3d6d9u, 0xbec3c7cbu, 0xacb1b5bau, 0x9a9ea3a7u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe4eaf2f9u, 0xdededfe1u, 0xd9dbdcddu); }
        case 19u: { v = vec4<u32>(0xcdd0d4d7u, 0xbbc0c4c9u, 0xa9adb2b7u, 0x969b9fa4u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe8eff6fbu, 0xdddee0e3u, 0xd7d9dadcu); }
        case 21u: { v = vec4<u32>(0xcaced1d4u, 0xb9bdc2c6u, 0xa5aaafb4u, 0x93979ca1u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf2f8fcu, 0xdcdee1e6u, 0xd5d7d9dau); }
        case 23u: { v = vec4<u32>(0xc8cccfd2u, 0xb6bbbfc4u, 0xa2a7acb1u, 0x9094999du); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xeff5fafdu, 0xdce0e4e9u, 0xd3d6d8dau); }
        case 25u: { v = vec4<u32>(0xc6cacdd0u, 0xb3b8bdc2u, 0x9fa4a9aeu, 0x8d91969bu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf2f8fbfeu, 0xdee2e7edu, 0xd2d5d7dau); }
        case 27u: { v = vec4<u32>(0xc4c8cccfu, 0xb1b6bbc0u, 0x9da2a7acu, 0x8a8f9398u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xe0e4eaf0u, 0xd1d4d8dbu); }
        case 29u: { v = vec4<u32>(0xc2c6caceu, 0xafb4b9beu, 0x9a9fa5aau, 0x888c9195u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe2e7edf2u, 0xd1d5d9ddu); }
        case 31u: { v = vec4<u32>(0xc1c5c9cdu, 0xadb2b7bcu, 0x989da2a8u, 0x868a8f93u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe4eaf0f5u, 0xd1d6dadfu); }
        case 33u: { v = vec4<u32>(0xbfc4c9cdu, 0xabb0b5bbu, 0x969ba0a6u, 0x84898d91u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe7edf2f6u, 0xd2d7dce1u); }
        case 35u: { v = vec4<u32>(0xbec3c8cdu, 0xa9afb4b9u, 0x959a9fa4u, 0x83878b90u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xeaeff4f8u, 0xd3d9dee4u); }
        case 37u: { v = vec4<u32>(0xbec3c8ceu, 0xa8adb3b8u, 0x93989da2u, 0x82868a8eu); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xecf1f6f9u, 0xd4dae0e6u); }
        case 39u: { v = vec4<u32>(0xbdc3c9cfu, 0xa7acb2b8u, 0x92979ca1u, 0x8185898du); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeef3f7fau, 0xd6dce3e9u); }
        case 41u: { v = vec4<u32>(0xbdc3cad0u, 0xa6abb1b7u, 0x91969ba0u, 0x8084888cu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf0f4f8fbu, 0xd8dee5ebu); }
        case 43u: { v = vec4<u32>(0xbdc4cad1u, 0xa5abb1b7u, 0x90949a9fu, 0x7f83878bu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf2f6f9fbu, 0xdae0e7edu); }
        case 45u: { v = vec4<u32>(0xbec5ccd3u, 0xa4aab0b7u, 0x8e93999eu, 0x7d81858au); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdbe2e8eeu); }
        case 47u: { v = vec4<u32>(0xbec5cdd4u, 0xa3aab0b7u, 0x8d92989du, 0x7b7f8488u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xdde4eaefu); }
        case 49u: { v = vec4<u32>(0xbfc6ced6u, 0xa3a9b0b7u, 0x8b90969cu, 0x787c8186u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xdee5ebf0u); }
        case 51u: { v = vec4<u32>(0xc0c8cfd7u, 0xa2a9b1b8u, 0x898f959bu, 0x74797e83u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f8fbfcu, 0xe0e6ecf1u); }
        case 53u: { v = vec4<u32>(0xc1c9d1d9u, 0xa2aab2bau, 0x878d949bu, 0x70757b81u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fafcu, 0xe2e8edf1u); }
        case 55u: { v = vec4<u32>(0xc4ccd4dbu, 0xa3abb3bcu, 0x858c949bu, 0x6c72787eu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf6f8fafcu, 0xe4eaeff3u); }
        case 57u: { v = vec4<u32>(0xc7cfd7deu, 0xa4adb6beu, 0x848c949cu, 0x686e757cu); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe8edf1f5u); }
        case 59u: { v = vec4<u32>(0xcbd3dae1u, 0xa6afb9c2u, 0x828b949du, 0x636b727au); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xebf0f4f7u); }
        case 61u: { v = vec4<u32>(0xcfd7dfe5u, 0xa9b3bcc6u, 0x818b949eu, 0x5f676f78u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xeef2f5f8u); }
        case 63u: { v = vec4<u32>(0xd3dbe2e8u, 0xacb6c0cau, 0x808b96a1u, 0x5a636c76u); }
        default: {}
      }
    }
    case 49u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefdfaffu, 0xfbfcfdfdu, 0xf6f7f9fau, 0xeef0f2f4u); }
        case 1u: { v = vec4<u32>(0xe4e6e9ebu, 0xd8dbdee1u, 0xcccfd2d5u, 0xc0c3c6c9u); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfafbfbfbu, 0xf5f7f8f9u, 0xedf0f2f3u); }
        case 3u: { v = vec4<u32>(0xe3e6e9ebu, 0xd8dbdee0u, 0xcbced1d4u, 0xbfc2c5c8u); }
        case 4u: { v = vec4<u32>(0xebe3f6ffu, 0xf7f7f5f2u, 0xf4f5f6f7u, 0xeceef0f2u); }
        case 5u: { v = vec4<u32>(0xe2e5e7eau, 0xd6d9dcdfu, 0xc9cccfd3u, 0xbcbfc2c6u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf2f1ede8u, 0xf2f3f3f3u, 0xebedeff0u); }
        case 7u: { v = vec4<u32>(0xe0e3e6e8u, 0xd4d7daddu, 0xc6cacdd0u, 0xb9bcbfc3u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xedeae6e3u, 0xefefefefu, 0xe9ebeceeu); }
        case 9u: { v = vec4<u32>(0xdee1e4e6u, 0xd1d5d8dbu, 0xc3c7caceu, 0xb5b8bcbfu); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe7e5e3e5u, 0xececebeau, 0xe6e8eaebu); }
        case 11u: { v = vec4<u32>(0xdcdfe2e4u, 0xced2d5d9u, 0xbfc3c7cbu, 0xb0b4b8bcu); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe3e2e4ebu, 0xe8e8e7e5u, 0xe4e6e7e8u); }
        case 13u: { v = vec4<u32>(0xd9dcdfe2u, 0xcbcfd3d6u, 0xbcc0c4c7u, 0xacb0b4b8u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe1e3e8f1u, 0xe5e4e3e2u, 0xe1e3e4e5u); }
        case 15u: { v = vec4<u32>(0xd7dadcdfu, 0xc8ccd0d3u, 0xb8bcc0c4u, 0xa7abafb4u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe2e6edf6u, 0xe2e1e1e1u, 0xdee0e1e2u); }
        case 17u: { v = vec4<u32>(0xd4d7dadcu, 0xc5c9cdd0u, 0xb4b8bdc1u, 0xa3a7abb0u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe4eaf2f9u, 0xdfdfe0e1u, 0xdcdddedfu); }
        case 19u: { v = vec4<u32>(0xd1d4d7dau, 0xc2c6caceu, 0xb0b5b9bdu, 0x9fa3a7acu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe8eff6fbu, 0xdddee0e3u, 0xd9dbdcddu); }
        case 21u: { v = vec4<u32>(0xcfd2d5d7u, 0xbfc3c7cbu, 0xacb1b6bau, 0x9b9fa3a8u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf2f8fcu, 0xdddfe2e6u, 0xd7d9dadbu); }
        case 23u: { v = vec4<u32>(0xcccfd2d5u, 0xbcc0c4c8u, 0xa9aeb2b7u, 0x979ba0a4u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xeff5fafdu, 0xdde0e4e9u, 0xd5d7d9dbu); }
        case 25u: { v = vec4<u32>(0xcacdd0d3u, 0xb9bdc2c6u, 0xa6aaafb4u, 0x93979ca1u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fbfeu, 0xdee2e7edu, 0xd4d6d9dbu); }
        case 27u: { v = vec4<u32>(0xc7cbced1u, 0xb6bbbfc3u, 0xa2a7acb1u, 0x9094999eu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xe0e5eaf0u, 0xd3d6d9dcu); }
        case 29u: { v = vec4<u32>(0xc5c9cdd0u, 0xb3b8bdc1u, 0x9fa4a9aeu, 0x8d91969bu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe2e8edf2u, 0xd3d6dadeu); }
        case 31u: { v = vec4<u32>(0xc4c8cccfu, 0xb1b6bbbfu, 0x9da2a7acu, 0x8a8e9398u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe5eaf0f5u, 0xd3d7dbe0u); }
        case 33u: { v = vec4<u32>(0xc2c7cbcfu, 0xafb4b9beu, 0x9a9fa4aau, 0x888c9195u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe7edf2f7u, 0xd3d8dde2u); }
        case 35u: { v = vec4<u32>(0xc1c6cacfu, 0xadb2b7bcu, 0x989da2a7u, 0x858a8e93u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xeaeff4f8u, 0xd4dadfe4u); }
        case 37u: { v = vec4<u32>(0xc0c5cacfu, 0xabb0b6bbu, 0x969ba0a6u, 0x83888c91u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xecf1f6f9u, 0xd6dbe1e7u); }
        case 39u: { v = vec4<u32>(0xbfc5cad0u, 0xa9afb4bau, 0x94999ea4u, 0x81868a8fu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeef3f7fau, 0xd7dde3e9u); }
        case 41u: { v = vec4<u32>(0xbfc5cbd1u, 0xa8adb3b9u, 0x92979ca2u, 0x8084888du); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf0f5f8fbu, 0xd9dfe5ebu); }
        case 43u: { v = vec4<u32>(0xbfc5ccd2u, 0xa6acb2b9u, 0x90959ba0u, 0x7e82868bu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf2f6f9fbu, 0xdbe1e7edu); }
        case 45u: { v = vec4<u32>(0xbfc6cdd4u, 0xa5abb2b8u, 0x8e93999fu, 0x7b7f8489u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdce3e9efu); }
        case 47u: { v = vec4<u32>(0xbfc6ced5u, 0xa3aab1b8u, 0x8b91979du, 0x777c8186u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xdee4ebf0u); }
        case 49u: { v = vec4<u32>(0xc0c7cfd6u, 0xa2a9b0b8u, 0x888e959bu, 0x73787d83u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f8fbfcu, 0xdfe6ecf1u); }
        case 51u: { v = vec4<u32>(0xc0c8d0d8u, 0xa1a9b0b8u, 0x868c939au, 0x6f747a80u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe0e7edf2u); }
        case 53u: { v = vec4<u32>(0xc1cad2d9u, 0xa1a9b1b9u, 0x848b9299u, 0x6b71777du); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe2e8edf2u); }
        case 55u: { v = vec4<u32>(0xc3cbd3dbu, 0xa1aab2bbu, 0x82899199u, 0x676d737au); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf6f9fbfcu, 0xe4e9eef3u); }
        case 57u: { v = vec4<u32>(0xc6ced6ddu, 0xa2abb4bdu, 0x80889099u, 0x62697078u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafbfdu, 0xe7ecf1f4u); }
        case 59u: { v = vec4<u32>(0xc9d1d9e0u, 0xa3adb7c0u, 0x7e87909au, 0x5e656d75u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfdu, 0xeaeff3f7u); }
        case 61u: { v = vec4<u32>(0xcdd6dde4u, 0xa5b0bac4u, 0x7d87919bu, 0x5a626a73u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xedf2f5f8u); }
        case 63u: { v = vec4<u32>(0xd2dae1e8u, 0xa8b4bec8u, 0x7c87929du, 0x565e6872u); }
        default: {}
      }
    }
    case 50u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefdfaffu, 0xfcfdfdfeu, 0xf7f9fafbu, 0xf1f3f4f6u); }
        case 1u: { v = vec4<u32>(0xe9ebedefu, 0xdfe2e4e7u, 0xd5d8daddu, 0xcacdd0d2u); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfbfbfbfbu, 0xf7f8f9fau, 0xf1f2f4f6u); }
        case 3u: { v = vec4<u32>(0xe8ebedefu, 0xdfe1e4e6u, 0xd4d7d9dcu, 0xc9cccfd1u); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xf8f7f6f2u, 0xf5f7f7f8u, 0xeff1f3f4u); }
        case 5u: { v = vec4<u32>(0xe7e9ebeeu, 0xdde0e2e5u, 0xd2d5d7dau, 0xc6c9cccfu); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf3f1ede8u, 0xf3f4f4f4u, 0xeeeff1f2u); }
        case 7u: { v = vec4<u32>(0xe5e8eaecu, 0xdbdde0e3u, 0xcfd2d5d8u, 0xc3c6c9ccu); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xedeae6e3u, 0xf0f1f0efu, 0xecedeff0u); }
        case 9u: { v = vec4<u32>(0xe3e5e8eau, 0xd8dbdee0u, 0xcbcfd2d5u, 0xbfc2c5c8u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe8e5e3e5u, 0xededeceau, 0xe9ebecedu); }
        case 11u: { v = vec4<u32>(0xe0e3e5e7u, 0xd5d8dbdeu, 0xc8cbced2u, 0xbabdc1c4u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe4e2e4ebu, 0xe9e9e8e6u, 0xe6e8e9e9u); }
        case 13u: { v = vec4<u32>(0xdee0e3e5u, 0xd2d5d8dbu, 0xc3c7cbceu, 0xb5b9bcc0u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe2e3e8f1u, 0xe6e5e4e2u, 0xe4e5e6e6u); }
        case 15u: { v = vec4<u32>(0xdbdee0e2u, 0xced2d5d8u, 0xbfc3c7cbu, 0xb0b4b8bbu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe2e6edf6u, 0xe3e2e1e1u, 0xe1e2e3e3u); }
        case 17u: { v = vec4<u32>(0xd8dbdddfu, 0xcbced2d5u, 0xbbbfc3c7u, 0xabafb3b7u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5eaf2f9u, 0xe0e0e0e1u, 0xdedfe0e0u); }
        case 19u: { v = vec4<u32>(0xd5d8dadcu, 0xc7cbcfd2u, 0xb7bbbfc3u, 0xa6aaafb3u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe8eff6fbu, 0xdedfe0e3u, 0xdbdcdddeu); }
        case 21u: { v = vec4<u32>(0xd2d5d8dau, 0xc4c8cccfu, 0xb3b7bcc0u, 0xa2a6aaaeu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf2f8fcu, 0xdedfe2e6u, 0xd9dadbdcu); }
        case 23u: { v = vec4<u32>(0xcfd2d5d7u, 0xc1c5c9ccu, 0xafb3b8bcu, 0x9da1a6aau); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f5fafdu, 0xdee0e4eau, 0xd7d9dadcu); }
        case 25u: { v = vec4<u32>(0xcdd0d3d5u, 0xbdc2c6c9u, 0xabb0b4b9u, 0x999da2a6u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fbfeu, 0xdfe3e7edu, 0xd5d7dadcu); }
        case 27u: { v = vec4<u32>(0xcaced1d3u, 0xbabfc3c7u, 0xa8acb1b6u, 0x95999ea3u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5f9fcfeu, 0xe1e5eaf0u, 0xd4d7daddu); }
        case 29u: { v = vec4<u32>(0xc8cccfd2u, 0xb7bcc0c4u, 0xa4a9aeb3u, 0x91969a9fu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe3e8edf3u, 0xd4d7dadeu); }
        case 31u: { v = vec4<u32>(0xc6cacdd1u, 0xb5b9bec2u, 0xa1a6abb0u, 0x8e92979cu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe5ebf0f5u, 0xd4d8dce0u); }
        case 33u: { v = vec4<u32>(0xc5c9ccd0u, 0xb2b7bcc0u, 0x9ea3a8adu, 0x8b8f9499u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe8edf2f7u, 0xd4d9dde3u); }
        case 35u: { v = vec4<u32>(0xc3c8ccd0u, 0xb0b5babfu, 0x9ba0a5abu, 0x888c9196u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xeaf0f4f8u, 0xd5dadfe5u); }
        case 37u: { v = vec4<u32>(0xc2c7ccd0u, 0xaeb3b8bdu, 0x989ea3a8u, 0x85898e93u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd6dce2e7u); }
        case 39u: { v = vec4<u32>(0xc1c7ccd1u, 0xabb1b6bcu, 0x969ba0a6u, 0x82878c90u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff3f7fau, 0xd8dee4e9u); }
        case 41u: { v = vec4<u32>(0xc1c6ccd2u, 0xa9afb5bbu, 0x93989ea4u, 0x7f84898eu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f8fbu, 0xdae0e6ebu); }
        case 43u: { v = vec4<u32>(0xc0c7cdd3u, 0xa8aeb4bau, 0x90969ca2u, 0x7c81868bu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf2f6f9fbu, 0xdbe2e8edu); }
        case 45u: { v = vec4<u32>(0xc0c7ced5u, 0xa5acb3b9u, 0x8d93999fu, 0x787d8288u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdde3e9efu); }
        case 47u: { v = vec4<u32>(0xc0c7cfd6u, 0xa4aab2b9u, 0x8a90969du, 0x74797e84u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xdee5ebf0u); }
        case 49u: { v = vec4<u32>(0xc0c8d0d7u, 0xa2a9b1b9u, 0x878d949bu, 0x6f757a80u); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f9fbfcu, 0xe0e6ecf1u); }
        case 51u: { v = vec4<u32>(0xc1c9d1d9u, 0xa1a9b1b9u, 0x848b9299u, 0x6b71777du); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe1e8edf2u); }
        case 53u: { v = vec4<u32>(0xc2cad2dau, 0xa0a8b1b9u, 0x81899098u, 0x676d737au); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe2e9eef3u); }
        case 55u: { v = vec4<u32>(0xc3ccd4dbu, 0xa0a9b2bau, 0x7f878f97u, 0x62697077u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe4eaeff3u); }
        case 57u: { v = vec4<u32>(0xc5ced6ddu, 0xa0aab3bcu, 0x7d858e97u, 0x5e656d75u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf7f9fbfcu, 0xe6ecf0f4u); }
        case 59u: { v = vec4<u32>(0xc8d1d9e0u, 0xa1abb5bfu, 0x7b848e97u, 0x5a626a72u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xeaeff3f6u); }
        case 61u: { v = vec4<u32>(0xccd5dce4u, 0xa3aeb8c2u, 0x7a848e99u, 0x565e6770u); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xedf2f5f8u); }
        case 63u: { v = vec4<u32>(0xd0d9e1e7u, 0xa6b1bcc7u, 0x79848f9bu, 0x525b646eu); }
        default: {}
      }
    }
    case 51u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xfcfdfefeu, 0xf9fafbfcu, 0xf4f5f7f8u); }
        case 1u: { v = vec4<u32>(0xedeff1f2u, 0xe6e8eaebu, 0xdddfe1e3u, 0xd4d6d9dbu); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfbfcfcfbu, 0xf8f9fafbu, 0xf3f5f6f7u); }
        case 3u: { v = vec4<u32>(0xedeff0f2u, 0xe5e7e9ebu, 0xdcdee1e3u, 0xd3d5d8dau); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xf8f8f6f2u, 0xf7f8f8f9u, 0xf2f4f5f6u); }
        case 5u: { v = vec4<u32>(0xebedeff1u, 0xe3e5e7e9u, 0xdadcdee1u, 0xd0d2d5d7u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf4f1eee8u, 0xf5f5f5f5u, 0xf0f2f3f4u); }
        case 7u: { v = vec4<u32>(0xe9ebedefu, 0xe1e3e5e7u, 0xd7d9dcdeu, 0xcccfd1d4u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xeeebe6e3u, 0xf2f2f1f0u, 0xeef0f1f1u); }
        case 9u: { v = vec4<u32>(0xe7e9ebedu, 0xdee0e3e5u, 0xd3d6d8dbu, 0xc7cacdd0u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe8e5e3e5u, 0xeeeeedebu, 0xecedeeeeu); }
        case 11u: { v = vec4<u32>(0xe4e7e8eau, 0xdadde0e2u, 0xcfd2d5d8u, 0xc2c6c9ccu); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe4e2e4ebu, 0xebeae8e6u, 0xe9eaebebu); }
        case 13u: { v = vec4<u32>(0xe2e4e6e7u, 0xd7dadddfu, 0xcaced1d4u, 0xbdc1c4c7u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe2e3e8f1u, 0xe7e6e4e3u, 0xe6e7e7e7u); }
        case 15u: { v = vec4<u32>(0xdfe1e3e4u, 0xd3d6d9dcu, 0xc6c9cdd0u, 0xb8bbbfc2u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe2e6edf6u, 0xe4e3e2e1u, 0xe3e4e4e4u); }
        case 17u: { v = vec4<u32>(0xdbdee0e1u, 0xd0d3d6d9u, 0xc1c5c9ccu, 0xb2b6babeu); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe1e0e1e2u, 0xe0e1e1e1u); }
        case 19u: { v = vec4<u32>(0xd8dbdddfu, 0xcccfd3d6u, 0xbdc1c5c8u, 0xadb1b5b9u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe8eff6fbu, 0xdfdfe1e4u, 0xdddededfu); }
        case 21u: { v = vec4<u32>(0xd5d8dadcu, 0xc8cccfd2u, 0xb9bdc1c5u, 0xa8acb0b4u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xdee0e2e6u, 0xdadcdcddu); }
        case 23u: { v = vec4<u32>(0xd2d5d7d9u, 0xc5c9cccfu, 0xb4b9bdc1u, 0xa3a7acb0u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xdee1e5eau, 0xd8dadbdcu); }
        case 25u: { v = vec4<u32>(0xcfd2d5d7u, 0xc1c5c9ccu, 0xb0b5b9bdu, 0x9ea3a7acu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fbfeu, 0xdfe3e7edu, 0xd7d8dadcu); }
        case 27u: { v = vec4<u32>(0xcdd0d2d5u, 0xbec2c6cau, 0xacb1b5bau, 0x9a9ea3a7u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe1e5eaf0u, 0xd5d8daddu); }
        case 29u: { v = vec4<u32>(0xcaced0d3u, 0xbbbfc3c7u, 0xa8adb2b6u, 0x959a9fa3u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe3e8edf3u, 0xd5d8dbdfu); }
        case 31u: { v = vec4<u32>(0xc8cccfd2u, 0xb8bcc1c5u, 0xa5a9aeb3u, 0x91969ba0u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd5d8dce1u); }
        case 33u: { v = vec4<u32>(0xc6caced1u, 0xb5babec2u, 0xa1a6abb0u, 0x8d92979cu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe8edf2f7u, 0xd5d9dee3u); }
        case 35u: { v = vec4<u32>(0xc5c9cdd1u, 0xb2b7bcc1u, 0x9ea3a8adu, 0x8a8f9399u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f4f8u, 0xd6dbe0e5u); }
        case 37u: { v = vec4<u32>(0xc4c8cdd1u, 0xb0b5babfu, 0x9aa0a5aau, 0x868b9095u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd7dde2e7u); }
        case 39u: { v = vec4<u32>(0xc3c8cdd2u, 0xadb3b8bdu, 0x979da2a8u, 0x83888d92u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff3f7fau, 0xd9dee4eau); }
        case 41u: { v = vec4<u32>(0xc2c8cdd3u, 0xabb1b7bcu, 0x949a9fa5u, 0x7f84898eu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f8fbu, 0xdae0e6ecu); }
        case 43u: { v = vec4<u32>(0xc1c8ced4u, 0xa8afb5bbu, 0x90969ca2u, 0x7b80858bu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf2f6f9fbu, 0xdce2e8eeu); }
        case 45u: { v = vec4<u32>(0xc1c8ced5u, 0xa6adb3bau, 0x8c93999fu, 0x767b8186u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xdde4eaefu); }
        case 47u: { v = vec4<u32>(0xc1c8cfd7u, 0xa4abb2bau, 0x898f969du, 0x71767c82u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fbfcu, 0xdfe6ebf0u); }
        case 49u: { v = vec4<u32>(0xc1c9d1d8u, 0xa2aab1b9u, 0x858c939bu, 0x6c72787fu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe1e7edf2u); }
        case 51u: { v = vec4<u32>(0xc2cad2d9u, 0xa1a9b1b9u, 0x828a9199u, 0x686e757bu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe2e8eef3u); }
        case 53u: { v = vec4<u32>(0xc2cbd3dbu, 0xa0a8b1bau, 0x80878f97u, 0x636a7178u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xe3e9eff3u); }
        case 55u: { v = vec4<u32>(0xc3ccd4dcu, 0x9fa8b1bbu, 0x7d858e96u, 0x5f666d75u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafbfdu, 0xe4eaeff3u); }
        case 57u: { v = vec4<u32>(0xc5ced6ddu, 0x9fa9b2bcu, 0x7b848d96u, 0x5b626a72u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf7f9fbfcu, 0xe6ecf0f4u); }
        case 59u: { v = vec4<u32>(0xc7d0d8e0u, 0xa0aab4beu, 0x79828c96u, 0x575f6770u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xe9eef3f6u); }
        case 61u: { v = vec4<u32>(0xcbd4dce3u, 0xa2adb7c1u, 0x77828c97u, 0x545c646eu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xedf1f5f8u); }
        case 63u: { v = vec4<u32>(0xcfd8e0e7u, 0xa4b0bbc6u, 0x77828d99u, 0x5059626cu); }
        default: {}
      }
    }
    case 52u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xfdfdfefeu, 0xfafbfcfcu, 0xf6f7f8f9u); }
        case 1u: { v = vec4<u32>(0xf1f2f4f5u, 0xebedeef0u, 0xe4e6e8e9u, 0xdddfe0e2u); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfcfcfcfbu, 0xfafbfbfcu, 0xf6f7f8f9u); }
        case 3u: { v = vec4<u32>(0xf1f2f3f5u, 0xeaeceeefu, 0xe3e5e7e9u, 0xdbdddfe1u); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xf9f8f6f2u, 0xf8f9f9f9u, 0xf5f6f7f8u); }
        case 5u: { v = vec4<u32>(0xeff1f2f3u, 0xe8eaeceeu, 0xe1e3e5e6u, 0xd8dadddfu); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf4f2eee8u, 0xf6f6f6f5u, 0xf3f4f5f5u); }
        case 7u: { v = vec4<u32>(0xedeff0f1u, 0xe6e8eaebu, 0xdde0e2e4u, 0xd4d7d9dbu); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xeeebe7e3u, 0xf3f3f2f0u, 0xf0f1f2f3u); }
        case 9u: { v = vec4<u32>(0xebeceeefu, 0xe3e5e7e9u, 0xd9dcdee0u, 0xcfd2d4d7u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe8e5e3e5u, 0xefefedebu, 0xeeefefefu); }
        case 11u: { v = vec4<u32>(0xe8eaebedu, 0xdfe2e4e6u, 0xd5d8daddu, 0xcacdd0d2u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe4e3e4ebu, 0xeceae9e7u, 0xebecececu); }
        case 13u: { v = vec4<u32>(0xe5e7e8eau, 0xdcdee1e3u, 0xd1d3d6d9u, 0xc4c7cbceu); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe2e3e8f1u, 0xe8e7e5e3u, 0xe8e8e9e8u); }
        case 15u: { v = vec4<u32>(0xe2e4e5e7u, 0xd8dbdddfu, 0xcccfd2d5u, 0xbfc2c5c9u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e6edf6u, 0xe4e3e2e2u, 0xe4e5e5e5u); }
        case 17u: { v = vec4<u32>(0xdee0e2e3u, 0xd4d7dadcu, 0xc7caced1u, 0xb9bcc0c4u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe1e1e1e2u, 0xe1e2e2e2u); }
        case 19u: { v = vec4<u32>(0xdbdddfe0u, 0xd0d3d6d9u, 0xc2c6c9cdu, 0xb3b7bbbeu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe8eff6fbu, 0xe0e0e1e4u, 0xdedfdfdfu); }
        case 21u: { v = vec4<u32>(0xd8dadcddu, 0xcccfd3d5u, 0xbdc1c5c9u, 0xadb1b5b9u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xdfe0e2e7u, 0xdcdddddeu); }
        case 23u: { v = vec4<u32>(0xd5d7d9dbu, 0xc8cccfd2u, 0xb9bdc1c5u, 0xa8acb0b5u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xdfe1e5eau, 0xd9dbdcddu); }
        case 25u: { v = vec4<u32>(0xd2d4d6d8u, 0xc5c8cccfu, 0xb4b9bdc1u, 0xa3a7acb0u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe0e3e8edu, 0xd8d9dbddu); }
        case 27u: { v = vec4<u32>(0xcfd2d4d6u, 0xc1c5c9ccu, 0xb0b4b9bdu, 0x9ea2a7abu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe1e6ebf0u, 0xd6d9dbdeu); }
        case 29u: { v = vec4<u32>(0xcccfd2d4u, 0xbec2c6c9u, 0xacb0b5b9u, 0x999ea2a7u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe3e8edf3u, 0xd6d8dcdfu); }
        case 31u: { v = vec4<u32>(0xcacdd0d3u, 0xbabfc3c7u, 0xa8acb1b6u, 0x94999ea3u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd6d9dde1u); }
        case 33u: { v = vec4<u32>(0xc8cccfd2u, 0xb7bcc0c4u, 0xa4a9aeb3u, 0x90959a9fu); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe8edf2f7u, 0xd6dadee3u); }
        case 35u: { v = vec4<u32>(0xc6caced2u, 0xb4b9bec2u, 0xa0a5aaafu, 0x8c91969bu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f4f8u, 0xd7dbe0e5u); }
        case 37u: { v = vec4<u32>(0xc5c9ced2u, 0xb2b7bcc0u, 0x9ca2a7acu, 0x878c9297u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd8dde2e8u); }
        case 39u: { v = vec4<u32>(0xc4c9ced3u, 0xafb4b9bfu, 0x989ea4a9u, 0x83888d93u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f7fau, 0xd9dfe4eau); }
        case 41u: { v = vec4<u32>(0xc3c8ced3u, 0xacb2b7bdu, 0x949aa0a6u, 0x7e83898fu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f8fbu, 0xdbe1e6ecu); }
        case 43u: { v = vec4<u32>(0xc2c8ced4u, 0xa9afb6bcu, 0x90969ca3u, 0x797e848au); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf2f6f9fcu, 0xdce2e8eeu); }
        case 45u: { v = vec4<u32>(0xc2c8cfd6u, 0xa7adb4bbu, 0x8c9299a0u, 0x74797f86u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xdee4eaefu); }
        case 47u: { v = vec4<u32>(0xc2c9d0d7u, 0xa4acb3bau, 0x888f969du, 0x6f757b82u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fbfcu, 0xe0e6ecf1u); }
        case 49u: { v = vec4<u32>(0xc2cad1d9u, 0xa3aab2bau, 0x858c939bu, 0x6a70777eu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe1e8edf2u); }
        case 51u: { v = vec4<u32>(0xc2cbd2dau, 0xa1a9b2bau, 0x81899199u, 0x666c737au); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xe3e9eef3u); }
        case 53u: { v = vec4<u32>(0xc3ccd4dbu, 0xa0a9b1bau, 0x7e868f97u, 0x61686f77u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe4eaeff4u); }
        case 55u: { v = vec4<u32>(0xc4cdd5ddu, 0x9fa8b2bbu, 0x7c848d96u, 0x5d646c74u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe5ebf0f4u); }
        case 57u: { v = vec4<u32>(0xc5ced7deu, 0x9fa9b3bcu, 0x7a838c95u, 0x59616971u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafbfdu, 0xe6ecf0f4u); }
        case 59u: { v = vec4<u32>(0xc7d0d8e0u, 0xa0aab4beu, 0x78818b95u, 0x555d666eu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe9eef2f6u); }
        case 61u: { v = vec4<u32>(0xcad3dbe3u, 0xa1acb7c1u, 0x76808b96u, 0x525a636cu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xcfd8e0e7u, 0xa3afbac5u, 0x75808c97u, 0x4f57616au); }
        default: {}
      }
    }
    case 53u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xfdfefefeu, 0xfbfcfdfdu, 0xf8f9fafbu); }
        case 1u: { v = vec4<u32>(0xf4f5f6f7u, 0xf0f1f2f3u, 0xeaecedeeu, 0xe4e6e7e9u); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfcfcfcfbu, 0xfbfbfcfcu, 0xf8f9f9fau); }
        case 3u: { v = vec4<u32>(0xf4f5f6f7u, 0xeff0f1f3u, 0xe9ebecedu, 0xe3e5e6e8u); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xf9f8f6f3u, 0xf9fafafau, 0xf7f7f8f9u); }
        case 5u: { v = vec4<u32>(0xf2f3f5f6u, 0xedeef0f1u, 0xe7e8eaebu, 0xe0e1e3e5u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf4f2eee8u, 0xf7f7f7f6u, 0xf5f5f6f7u); }
        case 7u: { v = vec4<u32>(0xf0f1f3f4u, 0xeaecedefu, 0xe3e5e7e8u, 0xdbdddfe1u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xeeebe7e3u, 0xf4f3f2f1u, 0xf2f3f4f4u); }
        case 9u: { v = vec4<u32>(0xeeeff0f1u, 0xe7e9eaecu, 0xdfe1e3e5u, 0xd6d9dbddu); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe9e5e3e5u, 0xf0efeeecu, 0xeff0f1f1u); }
        case 11u: { v = vec4<u32>(0xebecedefu, 0xe3e5e7e9u, 0xdbdddfe1u, 0xd1d3d6d8u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe4e3e4ebu, 0xecebe9e7u, 0xecedededu); }
        case 13u: { v = vec4<u32>(0xe8e9eaecu, 0xe0e2e4e6u, 0xd6d8dbddu, 0xcbced0d3u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe2e3e8f1u, 0xe8e7e5e3u, 0xe9eaeae9u); }
        case 15u: { v = vec4<u32>(0xe4e6e7e8u, 0xdcdee0e2u, 0xd1d4d6d9u, 0xc5c8cbceu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e6edf6u, 0xe5e4e2e2u, 0xe6e6e6e6u); }
        case 17u: { v = vec4<u32>(0xe1e3e4e5u, 0xd8dadddfu, 0xcccfd2d5u, 0xbec2c5c8u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe2e1e1e2u, 0xe3e3e3e3u); }
        case 19u: { v = vec4<u32>(0xdddfe1e2u, 0xd3d6d9dbu, 0xc7cacdd0u, 0xb8bcc0c3u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe8eff6fbu, 0xe0e0e1e4u, 0xe0e0e0e0u); }
        case 21u: { v = vec4<u32>(0xdadcdedfu, 0xcfd2d5d8u, 0xc2c5c9ccu, 0xb2b6babeu); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xdfe0e3e7u, 0xdddddedeu); }
        case 23u: { v = vec4<u32>(0xd7d9dadcu, 0xcbcfd2d4u, 0xbdc1c4c8u, 0xacb1b5b9u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xdfe1e5eau, 0xdadbdcddu); }
        case 25u: { v = vec4<u32>(0xd4d6d8d9u, 0xc7cbced1u, 0xb8bcc0c4u, 0xa7abafb4u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe0e3e8edu, 0xd9dadcddu); }
        case 27u: { v = vec4<u32>(0xd1d3d5d7u, 0xc4c7cbceu, 0xb3b7bcc0u, 0xa1a6aaafu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe1e6ebf0u, 0xd7d9dbdeu); }
        case 29u: { v = vec4<u32>(0xced1d3d5u, 0xc0c4c8cbu, 0xafb3b8bcu, 0x9ca1a5aau); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e8eef3u, 0xd6d9dcdfu); }
        case 31u: { v = vec4<u32>(0xcbced1d4u, 0xbdc1c5c8u, 0xaaafb4b8u, 0x979ca0a5u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd6d9dde1u); }
        case 33u: { v = vec4<u32>(0xc9cdd0d3u, 0xb9bec2c6u, 0xa6abb0b5u, 0x92979ca1u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe8eef2f7u, 0xd6dadfe3u); }
        case 35u: { v = vec4<u32>(0xc7cbcfd3u, 0xb6bbbfc3u, 0xa2a7acb1u, 0x8d92979cu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f4f8u, 0xd7dce0e6u); }
        case 37u: { v = vec4<u32>(0xc6caced3u, 0xb3b8bdc1u, 0x9da3a8aeu, 0x888d9398u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd8dde2e8u); }
        case 39u: { v = vec4<u32>(0xc4c9ced3u, 0xb0b5babfu, 0x999fa4aau, 0x83888e93u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f7fau, 0xd9dfe5eau); }
        case 41u: { v = vec4<u32>(0xc3c9ced4u, 0xadb2b8beu, 0x949aa1a7u, 0x7d83888eu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f8fbu, 0xdbe1e7ecu); }
        case 43u: { v = vec4<u32>(0xc3c9cfd5u, 0xaab0b6bdu, 0x90969da3u, 0x787d848au); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf2f6f9fcu, 0xdce3e8eeu); }
        case 45u: { v = vec4<u32>(0xc2c9d0d6u, 0xa7aeb5bcu, 0x8c9399a0u, 0x72797f85u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xdee5eaefu); }
        case 47u: { v = vec4<u32>(0xc2cad1d8u, 0xa5acb4bbu, 0x888f969eu, 0x6d747a81u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf5f8fbfcu, 0xe0e6ecf1u); }
        case 49u: { v = vec4<u32>(0xc3cad2d9u, 0xa3abb3bbu, 0x848c939bu, 0x696f767du); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe2e8edf2u); }
        case 51u: { v = vec4<u32>(0xc3cbd3dbu, 0xa1aab2bbu, 0x81899199u, 0x646b7279u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7f9fbfdu, 0xe3e9eff3u); }
        case 53u: { v = vec4<u32>(0xc4ccd4dcu, 0xa0a9b2bbu, 0x7e868f97u, 0x60676e76u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe4ebf0f4u); }
        case 55u: { v = vec4<u32>(0xc5ced6deu, 0xa0a9b2bcu, 0x7b848d96u, 0x5c636b73u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe6ecf1f5u); }
        case 57u: { v = vec4<u32>(0xc6cfd7dfu, 0x9fa9b3bdu, 0x79828c95u, 0x58606870u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe7ecf1f5u); }
        case 59u: { v = vec4<u32>(0xc8d1d9e0u, 0xa0aab4beu, 0x77818b95u, 0x545c656eu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe9eef2f5u); }
        case 61u: { v = vec4<u32>(0xcad3dbe3u, 0xa1acb6c1u, 0x75808b95u, 0x5159626bu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xced7dfe6u, 0xa2aeb9c4u, 0x747f8b96u, 0x4e56606au); }
        default: {}
      }
    }
    case 54u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xfefefefeu, 0xfcfdfdfeu, 0xfafbfbfcu); }
        case 1u: { v = vec4<u32>(0xf7f8f9f9u, 0xf3f4f5f6u, 0xeff0f1f2u, 0xebecedeeu); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfdfdfcfbu, 0xfcfcfcfdu, 0xfafafbfbu); }
        case 3u: { v = vec4<u32>(0xf6f7f8f9u, 0xf3f4f5f6u, 0xeeeff1f2u, 0xe9ebecedu); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfaf8f6f3u, 0xfafafafau, 0xf8f9f9fau); }
        case 5u: { v = vec4<u32>(0xf5f6f7f7u, 0xf1f2f3f4u, 0xecedeeefu, 0xe6e7e9eau); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf5f2eee9u, 0xf8f8f7f6u, 0xf6f7f7f8u); }
        case 7u: { v = vec4<u32>(0xf3f4f5f5u, 0xeeeff0f2u, 0xe8eaebecu, 0xe1e3e5e6u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefebe7e3u, 0xf5f4f3f1u, 0xf4f4f5f5u); }
        case 9u: { v = vec4<u32>(0xf0f1f2f3u, 0xeaecedefu, 0xe4e6e7e9u, 0xdcdee0e2u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe9e6e3e5u, 0xf1f0eeecu, 0xf1f1f2f1u); }
        case 11u: { v = vec4<u32>(0xedeeeff0u, 0xe7e9eaecu, 0xdfe1e3e5u, 0xd6d9dbddu); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xedeceae7u, 0xeeeeeeeeu); }
        case 13u: { v = vec4<u32>(0xeaebecedu, 0xe3e5e7e8u, 0xdadcdfe1u, 0xd0d3d5d8u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e3e8f1u, 0xe9e7e6e4u, 0xeaebebeau); }
        case 15u: { v = vec4<u32>(0xe6e8e9eau, 0xdfe1e3e5u, 0xd5d7dadcu, 0xcacdcfd2u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7edf6u, 0xe5e4e3e2u, 0xe7e7e7e6u); }
        case 17u: { v = vec4<u32>(0xe3e4e6e6u, 0xdadddfe1u, 0xd0d2d5d8u, 0xc3c6cacdu); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe2e2e1e2u, 0xe4e4e4e3u); }
        case 19u: { v = vec4<u32>(0xdfe1e2e3u, 0xd6d9dbddu, 0xcacdd0d3u, 0xbdc0c4c7u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe0e0e1e4u, 0xe1e1e1e1u); }
        case 21u: { v = vec4<u32>(0xdcdddfe0u, 0xd2d5d7dau, 0xc5c8cccfu, 0xb6babec1u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xdfe0e3e7u, 0xdedededfu); }
        case 23u: { v = vec4<u32>(0xd8dadcddu, 0xced1d4d6u, 0xc0c3c7cau, 0xb0b4b8bcu); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xdfe2e5eau, 0xdbdcdddeu); }
        case 25u: { v = vec4<u32>(0xd5d7d9dau, 0xcacdd0d3u, 0xbbbfc2c6u, 0xaaaeb2b7u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe0e3e8edu, 0xd9dbdcdeu); }
        case 27u: { v = vec4<u32>(0xd2d4d6d8u, 0xc6c9cccfu, 0xb6babec2u, 0xa4a9adb1u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd8dadcdeu); }
        case 29u: { v = vec4<u32>(0xcfd2d4d6u, 0xc2c6c9ccu, 0xb1b5babeu, 0x9ea3a8acu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e8eef3u, 0xd7d9dce0u); }
        case 31u: { v = vec4<u32>(0xcccfd2d4u, 0xbec2c6c9u, 0xacb1b5bau, 0x999ea3a7u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadde1u); }
        case 33u: { v = vec4<u32>(0xcacdd0d3u, 0xbbbfc3c7u, 0xa8adb1b6u, 0x93989da3u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xc8cccfd3u, 0xb7bcc0c4u, 0xa3a8adb2u, 0x8e93989eu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f4f8u, 0xd7dce1e6u); }
        case 37u: { v = vec4<u32>(0xc6cbcfd3u, 0xb4b9bdc2u, 0x9ea4a9aeu, 0x888e9399u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd8dde3e8u); }
        case 39u: { v = vec4<u32>(0xc5caced3u, 0xb0b6bbc0u, 0x999fa5abu, 0x82888e93u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f7fau, 0xdadfe5eau); }
        case 41u: { v = vec4<u32>(0xc4c9cfd4u, 0xadb3b9beu, 0x959ba1a7u, 0x7c82888eu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f8fbu, 0xdbe1e7ecu); }
        case 43u: { v = vec4<u32>(0xc3c9cfd5u, 0xaab1b7bdu, 0x90979da4u, 0x777d838au); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f6f9fcu, 0xdde3e9eeu); }
        case 45u: { v = vec4<u32>(0xc3c9d0d6u, 0xa8afb5bcu, 0x8c939aa1u, 0x72787f85u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xdfe5eaf0u); }
        case 47u: { v = vec4<u32>(0xc3cad1d8u, 0xa6adb4bcu, 0x888f979eu, 0x6d737a81u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f8fbfcu, 0xe0e7ecf1u); }
        case 49u: { v = vec4<u32>(0xc3cbd2d9u, 0xa4acb4bbu, 0x848c949cu, 0x686f767du); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe2e8eef2u); }
        case 51u: { v = vec4<u32>(0xc4ccd4dbu, 0xa2abb3bbu, 0x8189919au, 0x636a7279u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe4eaeff3u); }
        case 53u: { v = vec4<u32>(0xc5cdd5ddu, 0xa1aab3bcu, 0x7e868f98u, 0x5f666e76u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe5ebf0f4u); }
        case 55u: { v = vec4<u32>(0xc6ced7deu, 0xa0aab3bcu, 0x7b848d97u, 0x5b636a73u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe6ecf1f5u); }
        case 57u: { v = vec4<u32>(0xc7d0d8e0u, 0xa0aab4bdu, 0x79828c96u, 0x575f6770u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe7edf2f5u); }
        case 59u: { v = vec4<u32>(0xc8d1d9e1u, 0xa0aab5bfu, 0x77818b95u, 0x545c646du); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe9eef2f6u); }
        case 61u: { v = vec4<u32>(0xcad3dbe3u, 0xa0acb6c1u, 0x75808a95u, 0x5159626bu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xced7dfe6u, 0xa2aeb9c4u, 0x747f8a96u, 0x4d565f69u); }
        default: {}
      }
    }
    case 55u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xfefefefeu, 0xfdfdfefeu, 0xfbfcfcfdu); }
        case 1u: { v = vec4<u32>(0xf9fafafbu, 0xf7f7f8f9u, 0xf4f4f5f6u, 0xf0f1f2f3u); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfdfdfcfbu, 0xfcfdfdfdu, 0xfbfbfcfcu); }
        case 3u: { v = vec4<u32>(0xf9f9fafau, 0xf6f7f7f8u, 0xf2f3f4f5u, 0xeff0f1f2u); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfaf9f7f3u, 0xfbfbfbfbu, 0xfafafafbu); }
        case 5u: { v = vec4<u32>(0xf7f8f8f9u, 0xf4f5f5f6u, 0xf0f1f2f3u, 0xebeceeefu); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf5f2eee9u, 0xf8f8f8f7u, 0xf7f8f8f8u); }
        case 7u: { v = vec4<u32>(0xf5f6f6f7u, 0xf1f2f3f4u, 0xecedeff0u, 0xe7e8e9ebu); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefebe7e3u, 0xf5f5f3f2u, 0xf5f5f6f6u); }
        case 9u: { v = vec4<u32>(0xf2f3f4f4u, 0xedeff0f1u, 0xe8e9ebecu, 0xe1e3e4e6u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe9e6e3e5u, 0xf1f0efecu, 0xf2f2f2f2u); }
        case 11u: { v = vec4<u32>(0xeff0f1f2u, 0xeaebeceeu, 0xe3e5e6e8u, 0xdbdddfe1u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xedeceae7u, 0xefefefeeu); }
        case 13u: { v = vec4<u32>(0xecedeeeeu, 0xe5e7e9eau, 0xdee0e2e4u, 0xd5d7d9dbu); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e4e8f1u, 0xe9e8e6e4u, 0xebecebebu); }
        case 15u: { v = vec4<u32>(0xe8e9eaebu, 0xe1e3e5e7u, 0xd8dbdddfu, 0xced1d3d6u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7eef6u, 0xe6e4e3e2u, 0xe8e8e8e7u); }
        case 17u: { v = vec4<u32>(0xe4e6e7e8u, 0xdddfe1e3u, 0xd3d5d8dau, 0xc7cacdd0u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe3e2e2e2u, 0xe5e5e4e4u); }
        case 19u: { v = vec4<u32>(0xe1e2e3e4u, 0xd8dbdddfu, 0xcdd0d3d6u, 0xc0c4c7cau); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe1e1e2e4u, 0xe1e1e1e1u); }
        case 21u: { v = vec4<u32>(0xdddfe0e1u, 0xd4d7d9dbu, 0xc8cbced1u, 0xbabdc1c4u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xe0e1e3e7u, 0xdedfdfdfu); }
        case 23u: { v = vec4<u32>(0xd9dbdddeu, 0xd0d2d5d7u, 0xc2c6c9cdu, 0xb3b7bbbfu); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xdfe2e5eau, 0xdcdddddeu); }
        case 25u: { v = vec4<u32>(0xd6d8dadbu, 0xcbced1d4u, 0xbdc1c4c8u, 0xadb1b5b9u); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe0e4e8edu, 0xdadbdcdeu); }
        case 27u: { v = vec4<u32>(0xd3d5d7d8u, 0xc7cbced0u, 0xb8bcc0c4u, 0xa6abafb3u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd8dadcdfu); }
        case 29u: { v = vec4<u32>(0xd0d2d4d6u, 0xc3c7cacdu, 0xb3b7bbbfu, 0xa0a5aaaeu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e9eef3u, 0xd7dadce0u); }
        case 31u: { v = vec4<u32>(0xcdd0d2d5u, 0xbfc3c7cau, 0xaeb2b7bbu, 0x9a9fa4a9u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadee2u); }
        case 33u: { v = vec4<u32>(0xcbced1d4u, 0xbbc0c4c7u, 0xa9aeb2b7u, 0x94999fa4u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xc9ccd0d3u, 0xb8bcc1c5u, 0xa4a9aeb3u, 0x8e93999eu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f4f8u, 0xd7dce1e6u); }
        case 37u: { v = vec4<u32>(0xc7cbcfd3u, 0xb4b9bec2u, 0x9ea4aaafu, 0x888d9399u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd8dde3e8u); }
        case 39u: { v = vec4<u32>(0xc5cacfd4u, 0xb1b6bbc0u, 0x9a9fa5abu, 0x82888e94u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f7fau, 0xdadfe5eau); }
        case 41u: { v = vec4<u32>(0xc4cacfd4u, 0xaeb3b9bfu, 0x959ba1a8u, 0x7c82888fu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xdbe1e7ecu); }
        case 43u: { v = vec4<u32>(0xc4cacfd5u, 0xabb1b7beu, 0x90979ea4u, 0x767d838au); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f6f9fcu, 0xdde3e9eeu); }
        case 45u: { v = vec4<u32>(0xc3cad0d7u, 0xa8afb6bdu, 0x8c939aa1u, 0x71787e85u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f7fafcu, 0xdfe5ebf0u); }
        case 47u: { v = vec4<u32>(0xc3cad1d8u, 0xa6aeb5bcu, 0x8890979fu, 0x6c737a81u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f8fbfcu, 0xe1e7ecf1u); }
        case 49u: { v = vec4<u32>(0xc4cbd3dau, 0xa4acb4bcu, 0x858d949cu, 0x676e767du); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe2e9eef2u); }
        case 51u: { v = vec4<u32>(0xc4ccd4dcu, 0xa3abb4bcu, 0x818a929au, 0x636a7279u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe4eaeff4u); }
        case 53u: { v = vec4<u32>(0xc5ced6ddu, 0xa2abb4bdu, 0x7e879099u, 0x5f666e76u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe6ebf0f5u); }
        case 55u: { v = vec4<u32>(0xc6cfd7dfu, 0xa1aab4bdu, 0x7c858e97u, 0x5b636b73u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fbfcfdu, 0xe7edf1f5u); }
        case 57u: { v = vec4<u32>(0xc8d0d9e0u, 0xa0aab4beu, 0x79838c96u, 0x575f6770u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe8edf2f6u); }
        case 59u: { v = vec4<u32>(0xc9d2dae2u, 0xa0abb5bfu, 0x77818b96u, 0x545c646du); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe9eef2f6u); }
        case 61u: { v = vec4<u32>(0xcbd4dce3u, 0xa1acb7c1u, 0x75808a95u, 0x5059626bu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xced7dfe6u, 0xa2adb9c4u, 0x737f8a96u, 0x4d565f69u); }
        default: {}
      }
    }
    case 56u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xfefeffffu, 0xfefefefeu, 0xfcfdfdfdu); }
        case 1u: { v = vec4<u32>(0xfbfbfcfcu, 0xf9fafafbu, 0xf7f8f8f9u, 0xf5f5f6f6u); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfdfdfdfcu, 0xfdfdfdfdu, 0xfcfcfdfdu); }
        case 3u: { v = vec4<u32>(0xfafbfbfcu, 0xf8f9f9fau, 0xf6f7f7f8u, 0xf3f4f5f5u); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfaf9f7f3u, 0xfbfbfbfbu, 0xfbfbfbfbu); }
        case 5u: { v = vec4<u32>(0xf9f9fafau, 0xf6f7f8f8u, 0xf3f4f5f5u, 0xf0f0f1f2u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf5f2eee9u, 0xf9f9f8f7u, 0xf9f9f9f9u); }
        case 7u: { v = vec4<u32>(0xf6f7f8f8u, 0xf3f4f5f6u, 0xeff0f1f2u, 0xebecedeeu); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefebe7e3u, 0xf6f5f4f2u, 0xf6f6f6f6u); }
        case 9u: { v = vec4<u32>(0xf4f4f5f6u, 0xf0f1f2f3u, 0xebecedefu, 0xe5e7e8e9u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe9e6e3e5u, 0xf2f1efecu, 0xf3f3f3f3u); }
        case 11u: { v = vec4<u32>(0xf0f1f2f3u, 0xecedeeefu, 0xe6e7e9eau, 0xdfe1e2e4u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xeeeceae8u, 0xf0f0f0efu); }
        case 13u: { v = vec4<u32>(0xedeeefefu, 0xe8e9eaecu, 0xe0e2e4e6u, 0xd8dadcdeu); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e4e8f1u, 0xeae8e6e4u, 0xecececebu); }
        case 15u: { v = vec4<u32>(0xe9eaebecu, 0xe3e5e7e8u, 0xdbdddfe1u, 0xd1d4d6d9u); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7eef6u, 0xe6e5e3e2u, 0xe9e9e8e7u); }
        case 17u: { v = vec4<u32>(0xe6e7e8e8u, 0xdfe1e2e4u, 0xd5d8dadcu, 0xcacdd0d3u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe3e2e2e2u, 0xe5e5e5e4u); }
        case 19u: { v = vec4<u32>(0xe2e3e4e5u, 0xdadcdee0u, 0xcfd2d5d8u, 0xc3c6c9ccu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe1e1e2e4u, 0xe2e2e2e1u); }
        case 21u: { v = vec4<u32>(0xdee0e1e1u, 0xd5d8dadcu, 0xcacdd0d3u, 0xbcc0c3c6u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xe0e1e3e7u, 0xdfdfdfdfu); }
        case 23u: { v = vec4<u32>(0xdadcdddeu, 0xd1d4d6d8u, 0xc4c8cbceu, 0xb5b9bdc1u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xe0e2e5eau, 0xdcdddddeu); }
        case 25u: { v = vec4<u32>(0xd7d9dadbu, 0xcdd0d2d5u, 0xbfc2c6c9u, 0xafb3b7bbu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe0e4e8edu, 0xdadbdcdeu); }
        case 27u: { v = vec4<u32>(0xd4d6d7d9u, 0xc8cccfd1u, 0xb9bdc1c5u, 0xa8acb1b5u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd8dadcdfu); }
        case 29u: { v = vec4<u32>(0xd0d3d5d7u, 0xc4c8cbceu, 0xb4b8bcc0u, 0xa2a6abafu); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e9eef3u, 0xd7dadde0u); }
        case 31u: { v = vec4<u32>(0xced0d3d5u, 0xc0c4c7cbu, 0xafb3b8bcu, 0x9ba0a5aau); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadee2u); }
        case 33u: { v = vec4<u32>(0xcbced1d4u, 0xbcc0c4c8u, 0xa9aeb3b8u, 0x959a9fa4u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xc9ccd0d3u, 0xb8bdc1c5u, 0xa4a9aeb3u, 0x8e93999eu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f5f8u, 0xd8dce1e6u); }
        case 37u: { v = vec4<u32>(0xc7cbcfd3u, 0xb4b9bec3u, 0x9fa4aaafu, 0x888d9399u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd9dee3e8u); }
        case 39u: { v = vec4<u32>(0xc6cacfd4u, 0xb1b6bcc1u, 0x9aa0a6abu, 0x82888e94u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f7fau, 0xdadfe5eau); }
        case 41u: { v = vec4<u32>(0xc5cacfd5u, 0xaeb4babfu, 0x959ca2a8u, 0x7c82888fu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xdbe1e7ecu); }
        case 43u: { v = vec4<u32>(0xc4cad0d6u, 0xabb2b8beu, 0x91989ea5u, 0x767d838au); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f6f9fcu, 0xdde3e9eeu); }
        case 45u: { v = vec4<u32>(0xc4cad1d7u, 0xa9b0b7bdu, 0x8d949ba2u, 0x71787f86u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xdfe5ebf0u); }
        case 47u: { v = vec4<u32>(0xc4cbd2d9u, 0xa7aeb6bdu, 0x8990989fu, 0x6c737a81u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f8fbfcu, 0xe1e7edf1u); }
        case 49u: { v = vec4<u32>(0xc4ccd3dau, 0xa5adb5bdu, 0x858d959du, 0x686f767eu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe3e9eef3u); }
        case 51u: { v = vec4<u32>(0xc5cdd5dcu, 0xa4acb4bdu, 0x828a939bu, 0x636a727au); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe4eaeff4u); }
        case 53u: { v = vec4<u32>(0xc6ced6deu, 0xa2abb4bdu, 0x7f889099u, 0x5f666e76u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe6ecf1f5u); }
        case 55u: { v = vec4<u32>(0xc7d0d8dfu, 0xa2abb5beu, 0x7c858e98u, 0x5b636b73u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fbfcfdu, 0xe7edf2f5u); }
        case 57u: { v = vec4<u32>(0xc8d1d9e1u, 0xa1abb5bfu, 0x7a838d97u, 0x575f6870u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe9eef2f6u); }
        case 59u: { v = vec4<u32>(0xcad2dbe2u, 0xa1abb6c0u, 0x77818c96u, 0x545c656eu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf9fbfcfdu, 0xe9eff3f6u); }
        case 61u: { v = vec4<u32>(0xcbd4dce3u, 0xa1acb7c1u, 0x75808b96u, 0x5059626bu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xced7dfe6u, 0xa2adb9c3u, 0x747f8a96u, 0x4d565f69u); }
        default: {}
      }
    }
    case 57u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xfefefefeu, 0xfdfefefeu); }
        case 1u: { v = vec4<u32>(0xfcfdfdfdu, 0xfbfbfcfcu, 0xfafafafbu, 0xf8f9f9f9u); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfefdfdfcu, 0xfefefefeu, 0xfdfdfdfdu); }
        case 3u: { v = vec4<u32>(0xfcfcfcfdu, 0xfafbfbfbu, 0xf9f9f9fau, 0xf7f7f8f8u); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfaf9f7f3u, 0xfcfcfcfbu, 0xfbfcfcfcu); }
        case 5u: { v = vec4<u32>(0xfafafbfbu, 0xf8f9f9fau, 0xf6f6f7f8u, 0xf3f4f4f5u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf5f3eee9u, 0xf9f9f8f7u, 0xf9fafafau); }
        case 7u: { v = vec4<u32>(0xf8f8f9f9u, 0xf5f6f6f7u, 0xf2f3f3f4u, 0xeeeff0f1u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefece7e3u, 0xf6f5f4f2u, 0xf7f7f7f7u); }
        case 9u: { v = vec4<u32>(0xf5f5f6f6u, 0xf1f2f3f4u, 0xedeeeff0u, 0xe8e9ebecu); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe9e6e3e5u, 0xf2f1efedu, 0xf4f4f4f3u); }
        case 11u: { v = vec4<u32>(0xf2f2f3f3u, 0xedeff0f1u, 0xe8e9ebecu, 0xe2e3e5e6u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xeeedeae8u, 0xf0f0f0efu); }
        case 13u: { v = vec4<u32>(0xeeeff0f0u, 0xe9ebecedu, 0xe2e4e6e8u, 0xdbdddfe1u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e4e8f1u, 0xeae8e6e4u, 0xededecebu); }
        case 15u: { v = vec4<u32>(0xeaebecedu, 0xe5e6e8e9u, 0xdddfe1e3u, 0xd4d6d8dbu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7eef6u, 0xe6e5e3e2u, 0xe9e9e9e8u); }
        case 17u: { v = vec4<u32>(0xe6e8e8e9u, 0xe0e2e4e5u, 0xd7d9dcdeu, 0xcdcfd2d4u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe3e2e2e2u, 0xe6e6e5e4u); }
        case 19u: { v = vec4<u32>(0xe3e4e5e5u, 0xdbdddfe1u, 0xd1d4d6d9u, 0xc5c8cbceu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe1e1e2e4u, 0xe2e2e2e1u); }
        case 21u: { v = vec4<u32>(0xdfe0e1e2u, 0xd7d9dbddu, 0xcbced1d4u, 0xbec1c5c8u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xe0e1e3e7u, 0xdfdfdfe0u); }
        case 23u: { v = vec4<u32>(0xdbdddedfu, 0xd2d5d7d9u, 0xc5c9cccfu, 0xb7bbbec2u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xe0e2e5eau, 0xdcdddedeu); }
        case 25u: { v = vec4<u32>(0xd7d9dbdcu, 0xcdd0d3d5u, 0xc0c3c7cau, 0xb0b4b8bcu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe0e4e8edu, 0xdadbdddeu); }
        case 27u: { v = vec4<u32>(0xd4d6d8d9u, 0xc9cccfd2u, 0xbabec2c6u, 0xa9adb2b6u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd9dadcdfu); }
        case 29u: { v = vec4<u32>(0xd1d3d5d7u, 0xc5c8cbceu, 0xb5b9bdc1u, 0xa2a7acb0u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e9eef3u, 0xd8dadde0u); }
        case 31u: { v = vec4<u32>(0xced1d3d5u, 0xc0c4c8cbu, 0xafb3b8bcu, 0x9ba0a5aau); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadee2u); }
        case 33u: { v = vec4<u32>(0xcbced1d4u, 0xbcc0c4c8u, 0xa9aeb3b8u, 0x959a9fa4u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xc9cdd0d4u, 0xb8bdc1c5u, 0xa4a9afb4u, 0x8e94999fu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f5f8u, 0xd8dce1e6u); }
        case 37u: { v = vec4<u32>(0xc7cbcfd4u, 0xb5babec3u, 0x9fa5aab0u, 0x888e9399u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd9dee3e8u); }
        case 39u: { v = vec4<u32>(0xc6cbcfd4u, 0xb1b7bcc1u, 0x9aa0a6acu, 0x82888e94u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f7fau, 0xdadfe5eau); }
        case 41u: { v = vec4<u32>(0xc5cacfd5u, 0xaeb4babfu, 0x969ca2a8u, 0x7c82898fu); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xdce1e7ecu); }
        case 43u: { v = vec4<u32>(0xc4cad0d6u, 0xacb2b8beu, 0x91989fa5u, 0x777d848au); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7f9fcu, 0xdde3e9eeu); }
        case 45u: { v = vec4<u32>(0xc4cbd1d7u, 0xa9b0b7beu, 0x8d949ba2u, 0x71787f86u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xdfe5ebf0u); }
        case 47u: { v = vec4<u32>(0xc4cbd2d9u, 0xa7afb6bdu, 0x899198a0u, 0x6c737b82u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f8fbfcu, 0xe1e7edf1u); }
        case 49u: { v = vec4<u32>(0xc5ccd3dau, 0xa6aeb5bdu, 0x868e969eu, 0x686f767eu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe3e9eef3u); }
        case 51u: { v = vec4<u32>(0xc6cdd5dcu, 0xa4adb5bdu, 0x838b939cu, 0x636b727au); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe5ebf0f4u); }
        case 53u: { v = vec4<u32>(0xc6cfd7deu, 0xa3acb5beu, 0x7f88919au, 0x5f676f77u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe6ecf1f5u); }
        case 55u: { v = vec4<u32>(0xc8d0d8e0u, 0xa2acb5bfu, 0x7d868f99u, 0x5b636b74u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe8edf2f6u); }
        case 57u: { v = vec4<u32>(0xc9d2dae1u, 0xa2acb6bfu, 0x7a848d97u, 0x58606871u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe9eef3f6u); }
        case 59u: { v = vec4<u32>(0xcad3dbe3u, 0xa1acb6c0u, 0x78828c97u, 0x545c656eu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xeaeff3f7u); }
        case 61u: { v = vec4<u32>(0xccd5dde4u, 0xa1acb7c2u, 0x76808b96u, 0x5159626bu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xced7dfe6u, 0xa2adb9c4u, 0x747f8a96u, 0x4d565f69u); }
        default: {}
      }
    }
    case 58u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xfeffffffu, 0xfefefefeu); }
        case 1u: { v = vec4<u32>(0xfdfefefeu, 0xfdfdfdfdu, 0xfcfcfcfcu, 0xfbfbfbfcu); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfefdfdfcu, 0xfefefefeu, 0xfdfefefeu); }
        case 3u: { v = vec4<u32>(0xfdfdfdfdu, 0xfcfcfcfdu, 0xfbfbfbfbu, 0xf9fafafau); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfaf9f7f3u, 0xfcfcfcfbu, 0xfcfcfcfcu); }
        case 5u: { v = vec4<u32>(0xfbfbfcfcu, 0xf9fafafbu, 0xf8f8f9f9u, 0xf5f6f7f7u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf5f3eee9u, 0xfaf9f8f7u, 0xfafafafau); }
        case 7u: { v = vec4<u32>(0xf9f9f9fau, 0xf6f7f8f8u, 0xf4f4f5f6u, 0xf0f1f2f3u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefece7e3u, 0xf6f5f4f2u, 0xf7f7f7f7u); }
        case 9u: { v = vec4<u32>(0xf6f6f7f7u, 0xf3f4f4f5u, 0xeff0f1f2u, 0xeaecedeeu); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xe9e6e3e5u, 0xf3f1efedu, 0xf4f4f4f3u); }
        case 11u: { v = vec4<u32>(0xf2f3f4f4u, 0xeff0f1f2u, 0xeaebecedu, 0xe4e5e7e8u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xeeedeae8u, 0xf1f1f0f0u); }
        case 13u: { v = vec4<u32>(0xeff0f0f1u, 0xeaecedeeu, 0xe4e6e7e9u, 0xdddfe1e2u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e4e8f1u, 0xeae8e6e4u, 0xedededecu); }
        case 15u: { v = vec4<u32>(0xebecededu, 0xe6e7e9eau, 0xdee0e2e4u, 0xd6d8dadcu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7eef6u, 0xe6e5e3e2u, 0xeae9e9e8u); }
        case 17u: { v = vec4<u32>(0xe7e8e9e9u, 0xe1e3e4e6u, 0xd8dbdddfu, 0xced1d3d6u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe3e2e2e3u, 0xe6e6e5e4u); }
        case 19u: { v = vec4<u32>(0xe3e4e5e6u, 0xdcdee0e2u, 0xd2d5d7dau, 0xc7cacdcfu); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe1e1e2e4u, 0xe3e2e2e2u); }
        case 21u: { v = vec4<u32>(0xdfe1e2e2u, 0xd7dadcdeu, 0xcccfd2d5u, 0xbfc3c6c9u); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xe0e1e3e7u, 0xdfe0e0e0u); }
        case 23u: { v = vec4<u32>(0xdbdddedfu, 0xd3d5d8dau, 0xc6cacdd0u, 0xb8bcbfc3u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xe0e2e5eau, 0xdddddedfu); }
        case 25u: { v = vec4<u32>(0xd8d9dbdcu, 0xced1d3d6u, 0xc0c4c8cbu, 0xb1b5b9bdu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe1e4e8edu, 0xdadbdddeu); }
        case 27u: { v = vec4<u32>(0xd4d6d8d9u, 0xc9cdcfd2u, 0xbbbfc2c6u, 0xaaaeb2b6u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd9dadcdfu); }
        case 29u: { v = vec4<u32>(0xd1d3d5d7u, 0xc5c8cbceu, 0xb5b9bdc1u, 0xa2a7acb0u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e9eef3u, 0xd8dadde0u); }
        case 31u: { v = vec4<u32>(0xced1d3d5u, 0xc1c4c8cbu, 0xafb4b8bcu, 0x9ba0a5aau); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadee2u); }
        case 33u: { v = vec4<u32>(0xcbced1d4u, 0xbcc1c4c8u, 0xaaafb3b8u, 0x959a9fa4u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xc9cdd0d4u, 0xb9bdc1c5u, 0xa4aaafb4u, 0x8e94999fu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f5f8u, 0xd8dce1e6u); }
        case 37u: { v = vec4<u32>(0xc7ccd0d4u, 0xb5babfc3u, 0x9fa5aab0u, 0x888e9499u); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd9dee3e8u); }
        case 39u: { v = vec4<u32>(0xc6cbcfd4u, 0xb2b7bcc1u, 0x9aa1a6acu, 0x82888e94u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f7fau, 0xdae0e5eau); }
        case 41u: { v = vec4<u32>(0xc5cad0d5u, 0xafb5bac0u, 0x969ca3a9u, 0x7c838990u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xdce2e7ecu); }
        case 43u: { v = vec4<u32>(0xc5cad0d6u, 0xacb2b9bfu, 0x92989fa6u, 0x777d848bu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7f9fcu, 0xdee3e9eeu); }
        case 45u: { v = vec4<u32>(0xc4cbd1d7u, 0xaab1b7beu, 0x8e959ca3u, 0x72797f87u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xdfe5ebf0u); }
        case 47u: { v = vec4<u32>(0xc5ccd2d9u, 0xa8afb6beu, 0x8a9199a0u, 0x6d747b82u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f8fbfcu, 0xe1e7edf1u); }
        case 49u: { v = vec4<u32>(0xc5cdd4dbu, 0xa6aeb6beu, 0x868e969eu, 0x686f777fu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe3e9eef3u); }
        case 51u: { v = vec4<u32>(0xc6ced5dcu, 0xa5adb6beu, 0x838b949cu, 0x646b737bu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe5ebf0f4u); }
        case 53u: { v = vec4<u32>(0xc7cfd7deu, 0xa4adb6beu, 0x8089929bu, 0x60676f77u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe6ecf1f5u); }
        case 55u: { v = vec4<u32>(0xc8d1d9e0u, 0xa3acb6bfu, 0x7d869099u, 0x5c636c74u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe8edf2f6u); }
        case 57u: { v = vec4<u32>(0xc9d2dae1u, 0xa2acb6c0u, 0x7a848e98u, 0x58606871u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfdu, 0xe9eff3f6u); }
        case 59u: { v = vec4<u32>(0xcbd4dce3u, 0xa2acb7c1u, 0x78828d97u, 0x545c656eu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xeaeff4f7u); }
        case 61u: { v = vec4<u32>(0xccd5dde4u, 0xa2adb8c2u, 0x76808b96u, 0x5159626cu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f4f8u); }
        case 63u: { v = vec4<u32>(0xced7dfe6u, 0xa2aeb9c4u, 0x747f8a96u, 0x4e565f69u); }
        default: {}
      }
    }
    case 59u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xfefeffffu); }
        case 1u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfdfdfdfeu, 0xfdfdfdfdu); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfefdfdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfdfefefeu, 0xfdfdfdfdu, 0xfcfcfcfdu, 0xfbfbfcfcu); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfaf9f7f3u, 0xfcfcfcfbu, 0xfcfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfcfcfcu, 0xfafbfbfbu, 0xf9f9fafau, 0xf7f8f8f9u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf5f3efe9u, 0xfaf9f9f7u, 0xfafafafau); }
        case 7u: { v = vec4<u32>(0xf9fafafau, 0xf7f8f8f9u, 0xf5f6f6f7u, 0xf2f3f3f4u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefece7e3u, 0xf7f6f4f2u, 0xf8f8f7f7u); }
        case 9u: { v = vec4<u32>(0xf6f7f7f7u, 0xf4f4f5f6u, 0xf0f1f2f3u, 0xecedeeefu); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xeae6e3e5u, 0xf3f1efedu, 0xf5f4f4f4u); }
        case 11u: { v = vec4<u32>(0xf3f4f4f4u, 0xeff0f1f2u, 0xebecedeeu, 0xe5e7e8e9u); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xefedebe8u, 0xf1f1f1f0u); }
        case 13u: { v = vec4<u32>(0xeff0f1f1u, 0xebecedeeu, 0xe5e7e8eau, 0xdee0e2e3u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e4e8f1u, 0xeae9e6e4u, 0xedededecu); }
        case 15u: { v = vec4<u32>(0xebecededu, 0xe6e8e9eau, 0xdfe1e3e5u, 0xd7d9dbddu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7eef6u, 0xe7e5e3e2u, 0xeaeae9e8u); }
        case 17u: { v = vec4<u32>(0xe8e8e9eau, 0xe1e3e5e6u, 0xd9dbdde0u, 0xcfd2d4d7u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe3e2e2e3u, 0xe6e6e5e5u); }
        case 19u: { v = vec4<u32>(0xe4e5e5e6u, 0xdddfe0e2u, 0xd3d6d8dau, 0xc8cbcdd0u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe1e1e2e4u, 0xe3e3e2e2u); }
        case 21u: { v = vec4<u32>(0xe0e1e2e2u, 0xd8dadcdeu, 0xcdd0d3d5u, 0xc0c3c7cau); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xe0e1e3e7u, 0xdfe0e0e0u); }
        case 23u: { v = vec4<u32>(0xdcdddedfu, 0xd3d6d8dau, 0xc7cacdd0u, 0xb9bcc0c3u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xe0e2e5eau, 0xdddddedfu); }
        case 25u: { v = vec4<u32>(0xd8dadbdcu, 0xced1d4d6u, 0xc1c4c8cbu, 0xb1b5b9bdu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe1e4e8edu, 0xdadcdddeu); }
        case 27u: { v = vec4<u32>(0xd4d6d8d9u, 0xc9cdcfd2u, 0xbbbfc2c6u, 0xaaaeb2b7u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd9dadcdfu); }
        case 29u: { v = vec4<u32>(0xd1d3d5d7u, 0xc5c8ccceu, 0xb5b9bdc1u, 0xa2a7acb0u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e9eef3u, 0xd8dadde0u); }
        case 31u: { v = vec4<u32>(0xced1d3d5u, 0xc1c4c8cbu, 0xafb4b8bdu, 0x9ba0a5aau); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadee2u); }
        case 33u: { v = vec4<u32>(0xcccfd2d4u, 0xbdc1c5c8u, 0xaaafb4b8u, 0x959a9fa5u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xc9cdd0d4u, 0xb9bdc2c6u, 0xa4aaafb4u, 0x8e94999fu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f5f8u, 0xd8dce1e6u); }
        case 37u: { v = vec4<u32>(0xc8ccd0d4u, 0xb5babfc3u, 0xa0a5abb0u, 0x888e949au); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd9dee3e8u); }
        case 39u: { v = vec4<u32>(0xc6cbd0d4u, 0xb2b7bdc1u, 0x9ba1a7acu, 0x82888e95u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f8fau, 0xdae0e5eau); }
        case 41u: { v = vec4<u32>(0xc5cbd0d5u, 0xafb5bbc0u, 0x969da3a9u, 0x7d838990u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xdce2e7ecu); }
        case 43u: { v = vec4<u32>(0xc5cbd0d6u, 0xadb3b9bfu, 0x92999fa6u, 0x777e848bu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7f9fcu, 0xdee4e9eeu); }
        case 45u: { v = vec4<u32>(0xc5cbd1d8u, 0xaab1b8beu, 0x8e959ca3u, 0x72798087u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xdfe6ebf0u); }
        case 47u: { v = vec4<u32>(0xc5ccd3d9u, 0xa8b0b7beu, 0x8a9299a1u, 0x6d747b83u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f9fbfcu, 0xe1e7edf2u); }
        case 49u: { v = vec4<u32>(0xc5cdd4dbu, 0xa6aeb6beu, 0x878f979fu, 0x6870777fu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe3e9eef3u); }
        case 51u: { v = vec4<u32>(0xc6ced5ddu, 0xa5aeb6beu, 0x838c949du, 0x646c737bu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe5ebf0f4u); }
        case 53u: { v = vec4<u32>(0xc7cfd7deu, 0xa4adb6bfu, 0x8089929bu, 0x60687078u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe7ecf1f5u); }
        case 55u: { v = vec4<u32>(0xc8d1d9e0u, 0xa3adb6bfu, 0x7d87909au, 0x5c646c75u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe8eef2f6u); }
        case 57u: { v = vec4<u32>(0xcad2dae2u, 0xa3adb7c0u, 0x7b848e98u, 0x58606972u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xe9eff3f7u); }
        case 59u: { v = vec4<u32>(0xcbd4dce3u, 0xa2adb7c1u, 0x78828d97u, 0x555d656fu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xebf0f4f7u); }
        case 61u: { v = vec4<u32>(0xccd5dde5u, 0xa2adb8c3u, 0x76818c97u, 0x5159626cu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f4f8u); }
        case 63u: { v = vec4<u32>(0xced7dfe6u, 0xa2aeb9c4u, 0x747f8b96u, 0x4e56606au); }
        default: {}
      }
    }
    case 60u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xfefefefeu, 0xfefefefeu, 0xfefefefeu); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfefdfdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfdfefefeu, 0xfdfdfdfdu, 0xfcfcfdfdu); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfbf9f7f3u, 0xfdfcfcfbu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfcfcfdu, 0xfbfbfcfcu, 0xfafafafbu, 0xf8f9f9f9u); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf5f3efe9u, 0xfaf9f9f7u, 0xfbfbfbfau); }
        case 7u: { v = vec4<u32>(0xfafafafau, 0xf8f8f9f9u, 0xf6f6f7f7u, 0xf3f4f4f5u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefece7e3u, 0xf7f6f4f2u, 0xf8f8f8f7u); }
        case 9u: { v = vec4<u32>(0xf7f7f7f8u, 0xf4f5f5f6u, 0xf1f2f3f3u, 0xedeeeff0u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xeae6e3e5u, 0xf3f1efedu, 0xf5f5f4f4u); }
        case 11u: { v = vec4<u32>(0xf3f4f4f5u, 0xf0f1f2f3u, 0xebedeeefu, 0xe6e7e9eau); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xefedebe8u, 0xf1f1f1f0u); }
        case 13u: { v = vec4<u32>(0xf0f0f1f1u, 0xebedeeefu, 0xe6e7e9eau, 0xdfe1e2e4u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e4e8f1u, 0xeae9e6e4u, 0xeeededecu); }
        case 15u: { v = vec4<u32>(0xecededeeu, 0xe7e8e9ebu, 0xe0e2e3e5u, 0xd7dadcdeu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7eef6u, 0xe7e5e3e2u, 0xeaeae9e8u); }
        case 17u: { v = vec4<u32>(0xe8e9e9eau, 0xe2e4e5e7u, 0xd9dcdee0u, 0xd0d2d5d7u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe3e2e2e3u, 0xe6e6e5e5u); }
        case 19u: { v = vec4<u32>(0xe4e5e6e6u, 0xdddfe1e2u, 0xd3d6d8dbu, 0xc8cbced1u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe1e1e2e4u, 0xe3e3e2e2u); }
        case 21u: { v = vec4<u32>(0xe0e1e2e2u, 0xd8dadcdeu, 0xcdd0d3d5u, 0xc0c4c7cau); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xe0e1e3e7u, 0xe0e0e0e0u); }
        case 23u: { v = vec4<u32>(0xdcdddedfu, 0xd3d6d8dau, 0xc7cacdd0u, 0xb9bcc0c3u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xe0e2e5eau, 0xdddddedfu); }
        case 25u: { v = vec4<u32>(0xd8dadbdcu, 0xced1d4d6u, 0xc1c4c8cbu, 0xb1b5b9bdu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe1e4e8edu, 0xdadcdddeu); }
        case 27u: { v = vec4<u32>(0xd4d6d8d9u, 0xcacdd0d2u, 0xbbbfc2c6u, 0xaaaeb2b7u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd9dbdcdfu); }
        case 29u: { v = vec4<u32>(0xd1d3d5d7u, 0xc5c9cccfu, 0xb5b9bdc1u, 0xa3a7acb0u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e9eef3u, 0xd8dadde0u); }
        case 31u: { v = vec4<u32>(0xced1d3d6u, 0xc1c5c8cbu, 0xafb4b8bdu, 0x9ca1a6aau); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadee2u); }
        case 33u: { v = vec4<u32>(0xcccfd2d4u, 0xbdc1c5c8u, 0xaaafb4b8u, 0x959aa0a5u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xc9cdd0d4u, 0xb9bdc2c6u, 0xa5aaafb4u, 0x8e949a9fu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f5f8u, 0xd8dce1e6u); }
        case 37u: { v = vec4<u32>(0xc8ccd0d4u, 0xb5babfc3u, 0xa0a5abb0u, 0x888e949au); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd9dee3e8u); }
        case 39u: { v = vec4<u32>(0xc6cbd0d4u, 0xb2b8bdc2u, 0x9ba1a7adu, 0x82898f95u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f8fau, 0xdae0e5eau); }
        case 41u: { v = vec4<u32>(0xc5cbd0d5u, 0xafb5bbc0u, 0x979da3a9u, 0x7d838a90u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xdce2e7ecu); }
        case 43u: { v = vec4<u32>(0xc5cbd0d6u, 0xadb3b9bfu, 0x9299a0a6u, 0x777e858cu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdee4e9eeu); }
        case 45u: { v = vec4<u32>(0xc5cbd1d8u, 0xaab1b8beu, 0x8e959da4u, 0x72798087u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xe0e6ebf0u); }
        case 47u: { v = vec4<u32>(0xc5ccd3d9u, 0xa8b0b7beu, 0x8b929aa1u, 0x6d747c83u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f9fbfcu, 0xe1e7edf2u); }
        case 49u: { v = vec4<u32>(0xc6cdd4dbu, 0xa7afb6beu, 0x878f979fu, 0x6970787fu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe3e9eef3u); }
        case 51u: { v = vec4<u32>(0xc6ced6ddu, 0xa5aeb6beu, 0x848c949du, 0x646c747cu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe5ebf0f4u); }
        case 53u: { v = vec4<u32>(0xc7cfd7deu, 0xa4adb6bfu, 0x8189929bu, 0x60687078u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe7ecf1f5u); }
        case 55u: { v = vec4<u32>(0xc8d1d9e0u, 0xa3adb6c0u, 0x7e87909au, 0x5c646c75u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe8eef2f6u); }
        case 57u: { v = vec4<u32>(0xcad3dbe2u, 0xa3adb7c1u, 0x7b858f99u, 0x58606972u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xeaeff3f7u); }
        case 59u: { v = vec4<u32>(0xcbd4dce3u, 0xa2adb8c2u, 0x79838d98u, 0x555d666fu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xebf0f4f7u); }
        case 61u: { v = vec4<u32>(0xcdd6dee5u, 0xa2aeb8c3u, 0x76818c97u, 0x515a636cu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xced7dfe6u, 0xa3aeb9c4u, 0x747f8b97u, 0x4e57606au); }
        default: {}
      }
    }
    case 61u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xfeffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfefdfdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfdfdfefeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfbf9f7f3u, 0xfdfcfcfbu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfcfdfdu, 0xfbfcfcfcu, 0xfafbfbfbu, 0xf9f9fafau); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf5f3efe9u, 0xfaf9f9f7u, 0xfbfbfbfau); }
        case 7u: { v = vec4<u32>(0xfafafafbu, 0xf8f9f9f9u, 0xf6f7f7f8u, 0xf4f4f5f6u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefece7e3u, 0xf7f6f4f2u, 0xf8f8f8f7u); }
        case 9u: { v = vec4<u32>(0xf7f7f8f8u, 0xf4f5f6f6u, 0xf1f2f3f4u, 0xedeeeff0u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xeae6e3e5u, 0xf3f1efedu, 0xf5f5f4f4u); }
        case 11u: { v = vec4<u32>(0xf3f4f4f5u, 0xf0f1f2f3u, 0xecedeeefu, 0xe6e8e9eau); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xefedebe8u, 0xf1f1f1f0u); }
        case 13u: { v = vec4<u32>(0xf0f0f1f1u, 0xecedeeefu, 0xe6e7e9eau, 0xdfe1e3e4u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e4e8f1u, 0xeae9e6e4u, 0xeeededecu); }
        case 15u: { v = vec4<u32>(0xecededeeu, 0xe7e8eaebu, 0xe0e2e3e5u, 0xd8dadcdeu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7eef6u, 0xe7e5e3e2u, 0xeaeae9e8u); }
        case 17u: { v = vec4<u32>(0xe8e9e9eau, 0xe2e4e5e7u, 0xdadcdee0u, 0xd0d2d5d7u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe3e2e2e3u, 0xe6e6e5e5u); }
        case 19u: { v = vec4<u32>(0xe4e5e6e6u, 0xdddfe1e2u, 0xd3d6d8dbu, 0xc8cbced1u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe1e1e2e4u, 0xe3e3e2e2u); }
        case 21u: { v = vec4<u32>(0xe0e1e2e2u, 0xd8dadcdeu, 0xcdd0d3d5u, 0xc0c4c7cau); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xe0e1e3e7u, 0xe0e0e0e0u); }
        case 23u: { v = vec4<u32>(0xdcdddedfu, 0xd3d6d8dau, 0xc7cacdd0u, 0xb9bcc0c3u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xe0e2e5eau, 0xdddddedfu); }
        case 25u: { v = vec4<u32>(0xd8dadbdcu, 0xced1d4d6u, 0xc1c4c8cbu, 0xb1b5b9bdu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe1e4e8edu, 0xdbdcdddeu); }
        case 27u: { v = vec4<u32>(0xd4d6d8d9u, 0xcacdd0d2u, 0xbbbfc3c6u, 0xaaaeb2b7u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd9dbdcdfu); }
        case 29u: { v = vec4<u32>(0xd1d3d5d7u, 0xc5c9cccfu, 0xb5b9bdc1u, 0xa3a7acb1u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e9eef3u, 0xd8dadde0u); }
        case 31u: { v = vec4<u32>(0xced1d3d6u, 0xc1c5c8cbu, 0xafb4b9bdu, 0x9ca1a6abu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadee2u); }
        case 33u: { v = vec4<u32>(0xcccfd2d4u, 0xbdc1c5c8u, 0xaaafb4b8u, 0x959aa0a5u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xcacdd1d4u, 0xb9bec2c6u, 0xa5aaafb4u, 0x8f949a9fu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f5f8u, 0xd8dce1e6u); }
        case 37u: { v = vec4<u32>(0xc8ccd0d4u, 0xb6babfc4u, 0xa0a6abb0u, 0x888e949au); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd9dee3e8u); }
        case 39u: { v = vec4<u32>(0xc6cbd0d4u, 0xb2b8bdc2u, 0x9ba1a7adu, 0x83898f95u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f8fau, 0xdae0e5eau); }
        case 41u: { v = vec4<u32>(0xc6cbd0d5u, 0xafb5bbc0u, 0x979da3aau, 0x7d838a90u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xdce2e7ecu); }
        case 43u: { v = vec4<u32>(0xc5cbd1d6u, 0xadb3b9bfu, 0x9299a0a6u, 0x787e858cu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdee4e9eeu); }
        case 45u: { v = vec4<u32>(0xc5cbd1d8u, 0xabb1b8beu, 0x8f969da4u, 0x72798087u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xe0e6ebf0u); }
        case 47u: { v = vec4<u32>(0xc5ccd3d9u, 0xa9b0b7beu, 0x8b929aa1u, 0x6e757c83u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f9fbfcu, 0xe1e7edf2u); }
        case 49u: { v = vec4<u32>(0xc6cdd4dbu, 0xa7afb6beu, 0x878f979fu, 0x6970787fu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe3e9eef3u); }
        case 51u: { v = vec4<u32>(0xc6ced6ddu, 0xa6aeb6beu, 0x848c959du, 0x646c747cu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe5ebf0f4u); }
        case 53u: { v = vec4<u32>(0xc7d0d7deu, 0xa4adb6bfu, 0x818a929bu, 0x60687078u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe7ecf1f5u); }
        case 55u: { v = vec4<u32>(0xc9d1d9e0u, 0xa4adb6c0u, 0x7e87919au, 0x5c646c75u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe8eef2f6u); }
        case 57u: { v = vec4<u32>(0xcad3dbe2u, 0xa3adb7c1u, 0x7b858f99u, 0x58616972u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xeaeff3f7u); }
        case 59u: { v = vec4<u32>(0xcbd4dce4u, 0xa3adb8c2u, 0x79838d98u, 0x555d666fu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xebf0f4f7u); }
        case 61u: { v = vec4<u32>(0xcdd6dee5u, 0xa3aeb9c3u, 0x77818c97u, 0x515a636cu); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xced7dfe6u, 0xa3aebac4u, 0x75808b97u, 0x4e57606au); }
        default: {}
      }
    }
    case 62u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfefdfdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfefefefeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfbf9f7f3u, 0xfdfcfcfbu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfdfdfdu, 0xfcfcfcfcu, 0xfafbfbfbu, 0xf9f9fafau); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf6f3efe9u, 0xfafaf9f7u, 0xfbfbfbfau); }
        case 7u: { v = vec4<u32>(0xfafafafbu, 0xf8f9f9fau, 0xf6f7f7f8u, 0xf4f4f5f6u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefece7e3u, 0xf7f6f4f2u, 0xf8f8f8f7u); }
        case 9u: { v = vec4<u32>(0xf7f7f8f8u, 0xf4f5f6f6u, 0xf1f2f3f4u, 0xeeefeff0u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xeae6e3e5u, 0xf3f1efedu, 0xf5f5f4f4u); }
        case 11u: { v = vec4<u32>(0xf3f4f4f5u, 0xf0f1f2f3u, 0xecedeeefu, 0xe7e8e9ebu); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xefedebe8u, 0xf1f1f1f0u); }
        case 13u: { v = vec4<u32>(0xf0f0f1f1u, 0xecedeeefu, 0xe6e7e9eau, 0xdfe1e3e4u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e4e8f1u, 0xeae9e6e4u, 0xeeededecu); }
        case 15u: { v = vec4<u32>(0xecededeeu, 0xe7e8eaebu, 0xe0e2e4e5u, 0xd8dadcdeu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7eef6u, 0xe7e5e3e2u, 0xeaeae9e8u); }
        case 17u: { v = vec4<u32>(0xe8e9e9eau, 0xe2e4e5e7u, 0xdadcdee0u, 0xd0d2d5d7u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe3e2e2e3u, 0xe6e6e5e5u); }
        case 19u: { v = vec4<u32>(0xe4e5e6e6u, 0xdddfe1e2u, 0xd3d6d8dbu, 0xc8cbced1u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe1e1e2e4u, 0xe3e3e2e2u); }
        case 21u: { v = vec4<u32>(0xe0e1e2e3u, 0xd8dadcdeu, 0xcdd0d3d5u, 0xc0c4c7cau); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xe0e1e3e7u, 0xe0e0e0e0u); }
        case 23u: { v = vec4<u32>(0xdcdddedfu, 0xd3d6d8dau, 0xc7cacdd0u, 0xb9bcc0c3u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xe0e2e5eau, 0xdddddedfu); }
        case 25u: { v = vec4<u32>(0xd8dadbdcu, 0xced1d4d6u, 0xc1c4c8cbu, 0xb1b5b9bdu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe1e4e8edu, 0xdbdcdddeu); }
        case 27u: { v = vec4<u32>(0xd4d6d8d9u, 0xcacdd0d2u, 0xbbbfc3c6u, 0xaaaeb2b7u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd9dbdcdfu); }
        case 29u: { v = vec4<u32>(0xd1d3d5d7u, 0xc5c9cccfu, 0xb5b9bdc1u, 0xa3a7acb1u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e9eef3u, 0xd8dadde0u); }
        case 31u: { v = vec4<u32>(0xced1d3d6u, 0xc1c5c8cbu, 0xafb4b9bdu, 0x9ca1a6abu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadee2u); }
        case 33u: { v = vec4<u32>(0xcccfd2d4u, 0xbdc1c5c8u, 0xaaafb4b8u, 0x959aa0a5u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xcacdd1d4u, 0xb9bec2c6u, 0xa5aaafb4u, 0x8f949a9fu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f5f8u, 0xd8dce1e6u); }
        case 37u: { v = vec4<u32>(0xc8ccd0d4u, 0xb6bbbfc4u, 0xa0a6abb1u, 0x898e949au); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd9dee3e8u); }
        case 39u: { v = vec4<u32>(0xc6cbd0d4u, 0xb2b8bdc2u, 0x9ba1a7adu, 0x83898f95u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f8fau, 0xdae0e5eau); }
        case 41u: { v = vec4<u32>(0xc6cbd0d5u, 0xb0b5bbc0u, 0x979da3aau, 0x7d838a90u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xdce2e7ecu); }
        case 43u: { v = vec4<u32>(0xc5cbd1d6u, 0xadb3b9bfu, 0x9399a0a7u, 0x787e858cu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdee4e9eeu); }
        case 45u: { v = vec4<u32>(0xc5cbd1d8u, 0xabb1b8bfu, 0x8f969da4u, 0x73798087u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xe0e6ebf0u); }
        case 47u: { v = vec4<u32>(0xc5ccd3d9u, 0xa9b0b7beu, 0x8b929aa1u, 0x6e757c83u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f9fbfcu, 0xe1e7edf2u); }
        case 49u: { v = vec4<u32>(0xc6cdd4dbu, 0xa7afb7beu, 0x878f979fu, 0x6970787fu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe3e9eef3u); }
        case 51u: { v = vec4<u32>(0xc6ced6ddu, 0xa6aeb6beu, 0x848c959du, 0x656c747cu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe5ebf0f4u); }
        case 53u: { v = vec4<u32>(0xc7d0d7dfu, 0xa4adb6bfu, 0x818a939bu, 0x60687078u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe7ecf1f5u); }
        case 55u: { v = vec4<u32>(0xc9d1d9e0u, 0xa4adb7c0u, 0x7e87919au, 0x5c646c75u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe8eef2f6u); }
        case 57u: { v = vec4<u32>(0xcad3dbe2u, 0xa3adb7c1u, 0x7b858f99u, 0x59616972u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xeaeff3f7u); }
        case 59u: { v = vec4<u32>(0xcbd4dce4u, 0xa3adb8c2u, 0x79838d98u, 0x555d666fu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xebf0f4f7u); }
        case 61u: { v = vec4<u32>(0xcdd6dee5u, 0xa3aeb9c3u, 0x77818c97u, 0x515a636du); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xced8e0e6u, 0xa3aebac5u, 0x75808b97u, 0x4e57606au); }
        default: {}
      }
    }
    case 63u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfefefaffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xf9f3e3ffu, 0xfefdfdfcu, 0xfefefefeu, 0xfefefefeu); }
        case 3u: { v = vec4<u32>(0xfefefefeu, 0xfefefefeu, 0xfefefefeu, 0xfdfdfdfdu); }
        case 4u: { v = vec4<u32>(0xece3f6ffu, 0xfbf9f7f3u, 0xfdfcfcfbu, 0xfdfdfdfdu); }
        case 5u: { v = vec4<u32>(0xfcfdfdfdu, 0xfcfcfcfcu, 0xfafbfbfbu, 0xf9fafafau); }
        case 6u: { v = vec4<u32>(0xe3ebfdffu, 0xf6f3efe9u, 0xfafaf9f7u, 0xfbfbfbfau); }
        case 7u: { v = vec4<u32>(0xfafafafbu, 0xf8f9f9fau, 0xf6f7f7f8u, 0xf4f4f5f6u); }
        case 8u: { v = vec4<u32>(0xe7f6feffu, 0xefece7e3u, 0xf7f6f4f2u, 0xf8f8f8f7u); }
        case 9u: { v = vec4<u32>(0xf7f7f8f8u, 0xf4f5f6f6u, 0xf1f2f3f4u, 0xeeefeff0u); }
        case 10u: { v = vec4<u32>(0xeffbffffu, 0xeae6e3e5u, 0xf3f1efedu, 0xf5f5f4f4u); }
        case 11u: { v = vec4<u32>(0xf3f4f4f5u, 0xf0f1f2f3u, 0xecedeeefu, 0xe7e8e9ebu); }
        case 12u: { v = vec4<u32>(0xf6fdffffu, 0xe5e3e4ebu, 0xefedebe8u, 0xf1f1f1f0u); }
        case 13u: { v = vec4<u32>(0xf0f0f1f1u, 0xecedeeefu, 0xe6e7e9eau, 0xdfe1e3e4u); }
        case 14u: { v = vec4<u32>(0xfafeffffu, 0xe3e4e8f1u, 0xeae9e6e4u, 0xeeededecu); }
        case 15u: { v = vec4<u32>(0xecededeeu, 0xe7e8eaebu, 0xe0e2e4e5u, 0xd8dadcdeu); }
        case 16u: { v = vec4<u32>(0xfcfeffffu, 0xe3e7eef6u, 0xe7e5e3e2u, 0xeaeae9e8u); }
        case 17u: { v = vec4<u32>(0xe8e9e9eau, 0xe2e4e5e7u, 0xdadcdee0u, 0xd0d2d5d7u); }
        case 18u: { v = vec4<u32>(0xfdffffffu, 0xe5ebf2f9u, 0xe3e2e2e3u, 0xe6e6e5e5u); }
        case 19u: { v = vec4<u32>(0xe4e5e6e6u, 0xdddfe1e2u, 0xd3d6d8dbu, 0xc8cbced1u); }
        case 20u: { v = vec4<u32>(0xfeffffffu, 0xe9eff6fbu, 0xe1e1e2e4u, 0xe3e3e2e2u); }
        case 21u: { v = vec4<u32>(0xe0e1e2e3u, 0xd8dadcdeu, 0xcdd0d3d5u, 0xc0c4c7cau); }
        case 22u: { v = vec4<u32>(0xfeffffffu, 0xecf3f8fcu, 0xe0e1e3e7u, 0xe0e0e0e0u); }
        case 23u: { v = vec4<u32>(0xdcdddedfu, 0xd3d6d8dau, 0xc7cacdd0u, 0xb9bcc0c3u); }
        case 24u: { v = vec4<u32>(0xfeffffffu, 0xf0f6fafdu, 0xe0e2e5eau, 0xdddddedfu); }
        case 25u: { v = vec4<u32>(0xd8dadbdcu, 0xced1d4d6u, 0xc1c4c8cbu, 0xb1b5b9bdu); }
        case 26u: { v = vec4<u32>(0xffffffffu, 0xf3f8fcfeu, 0xe1e4e8edu, 0xdbdcdddeu); }
        case 27u: { v = vec4<u32>(0xd4d6d8d9u, 0xcacdd0d2u, 0xbbbfc3c6u, 0xaaaeb2b7u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xf5fafcfeu, 0xe2e6ebf0u, 0xd9dbdcdfu); }
        case 29u: { v = vec4<u32>(0xd1d3d5d7u, 0xc5c9cccfu, 0xb5b9bdc1u, 0xa3a7acb1u); }
        case 30u: { v = vec4<u32>(0xffffffffu, 0xf7fbfdfeu, 0xe4e9eef3u, 0xd8dadde0u); }
        case 31u: { v = vec4<u32>(0xced1d3d6u, 0xc1c5c8cbu, 0xafb4b9bdu, 0x9ca1a6abu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xf9fcfdfeu, 0xe6ebf0f5u, 0xd7dadee2u); }
        case 33u: { v = vec4<u32>(0xcccfd2d4u, 0xbdc1c5c8u, 0xaaafb4b8u, 0x959aa0a5u); }
        case 34u: { v = vec4<u32>(0xffffffffu, 0xfafcfeffu, 0xe9eef3f7u, 0xd7dbdfe4u); }
        case 35u: { v = vec4<u32>(0xcacdd1d4u, 0xb9bec2c6u, 0xa5aaafb4u, 0x8f949a9fu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfbfdfeffu, 0xebf0f5f8u, 0xd8dce1e6u); }
        case 37u: { v = vec4<u32>(0xc8ccd0d4u, 0xb6bbbfc4u, 0xa0a6abb1u, 0x898e949au); }
        case 38u: { v = vec4<u32>(0xffffffffu, 0xfcfdfeffu, 0xedf2f6f9u, 0xd9dee3e8u); }
        case 39u: { v = vec4<u32>(0xc6cbd0d4u, 0xb2b8bdc2u, 0x9ba1a7adu, 0x83898f95u); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfcfefeffu, 0xeff4f8fau, 0xdae0e5eau); }
        case 41u: { v = vec4<u32>(0xc6cbd0d5u, 0xb0b5bbc0u, 0x979da3aau, 0x7d838a90u); }
        case 42u: { v = vec4<u32>(0xffffffffu, 0xfdfefeffu, 0xf1f5f9fbu, 0xdce2e7ecu); }
        case 43u: { v = vec4<u32>(0xc5cbd1d6u, 0xadb3b9bfu, 0x9399a0a7u, 0x787e858cu); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf3f7fafcu, 0xdee4e9eeu); }
        case 45u: { v = vec4<u32>(0xc5cbd1d8u, 0xabb1b8bfu, 0x8f969da4u, 0x73798087u); }
        case 46u: { v = vec4<u32>(0xffffffffu, 0xfdfeffffu, 0xf4f8fafcu, 0xe0e6ebf0u); }
        case 47u: { v = vec4<u32>(0xc5ccd3d9u, 0xa9b0b7beu, 0x8b929aa1u, 0x6e757c83u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf5f9fbfcu, 0xe1e7edf2u); }
        case 49u: { v = vec4<u32>(0xc6cdd4dbu, 0xa7afb7beu, 0x878f979fu, 0x6970787fu); }
        case 50u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf6f9fbfdu, 0xe3e9eef3u); }
        case 51u: { v = vec4<u32>(0xc6ced6ddu, 0xa6aeb6beu, 0x848c959du, 0x656c747cu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf7fafcfdu, 0xe5ebf0f4u); }
        case 53u: { v = vec4<u32>(0xc7d0d7dfu, 0xa4adb6bfu, 0x818a939bu, 0x60687078u); }
        case 54u: { v = vec4<u32>(0xffffffffu, 0xfefeffffu, 0xf8fafcfdu, 0xe7ecf1f5u); }
        case 55u: { v = vec4<u32>(0xc9d1d9e0u, 0xa4adb7c0u, 0x7e87919au, 0x5c646d75u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfcfdu, 0xe8eef2f6u); }
        case 57u: { v = vec4<u32>(0xcad3dbe2u, 0xa3adb7c1u, 0x7b858f99u, 0x59616972u); }
        case 58u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xf9fbfdfeu, 0xeaeff3f7u); }
        case 59u: { v = vec4<u32>(0xcbd4dce4u, 0xa3adb8c2u, 0x79838d98u, 0x555d666fu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafbfdfeu, 0xebf0f4f7u); }
        case 61u: { v = vec4<u32>(0xcdd6dee5u, 0xa3aeb9c3u, 0x77818c97u, 0x525a636du); }
        case 62u: { v = vec4<u32>(0xffffffffu, 0xfeffffffu, 0xfafcfdfeu, 0xecf1f5f8u); }
        case 63u: { v = vec4<u32>(0xcfd8e0e6u, 0xa3aebac5u, 0x75808b97u, 0x4e57606au); }
        default: {}
      }
    }
    default: {}
  }
  if (lane == 0u) { return v.x; }
  if (lane == 1u) { return v.y; }
  if (lane == 2u) { return v.z; }
  return v.w;
}

fn bsdf_glass_lut_eavg_u32(word_idx: u32) -> u32 {
  let vec_idx = word_idx >> 2u;
  let lane = word_idx & 3u;
  var v = vec4<u32>(0u);
  switch (vec_idx >> 6u) {
    case 0u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 3u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 4u: { v = vec4<u32>(0xffffffffu, 0xfff5fffcu, 0xffc4ffe4u, 0xff3bff8du); }
        case 5u: { v = vec4<u32>(0xfe30fec8u, 0xfc89fd71u, 0xfa43fb7au, 0xf763f8e5u); }
        case 6u: { v = vec4<u32>(0xf3fcf5bfu, 0xf026f21eu, 0xebfaee19u, 0xe793e9cdu); }
        case 7u: { v = vec4<u32>(0xe30ae552u, 0xde74e0c0u, 0xd9e3dc2au, 0xd566d7a2u); }
        case 8u: { v = vec4<u32>(0xffffffffu, 0xfff4fffcu, 0xffc6ffe3u, 0xff52ff98u); }
        case 9u: { v = vec4<u32>(0xfe67feeeu, 0xfce1fdb8u, 0xfab2fbdeu, 0xf7e1f95du); }
        case 10u: { v = vec4<u32>(0xf480f641u, 0xf0a8f2a1u, 0xec75ee98u, 0xe802ea42u); }
        case 11u: { v = vec4<u32>(0xe369e5b9u, 0xdec1e116u, 0xda1cdc6du, 0xd58ad7d0u); }
        case 12u: { v = vec4<u32>(0xffffffffu, 0xfff3fffcu, 0xffc4ffe1u, 0xff59ff98u); }
        case 13u: { v = vec4<u32>(0xfe87ff00u, 0xfd26fdebu, 0xfb1cfc37u, 0xf868f9d7u); }
        case 14u: { v = vec4<u32>(0xf518f6d2u, 0xf145f33du, 0xed0def34u, 0xe88dead4u); }
        case 15u: { v = vec4<u32>(0xe3e0e63au, 0xdf1fe180u, 0xda5cdcbcu, 0xd5a9d800u); }
        case 16u: { v = vec4<u32>(0xffffffffu, 0xfff2fffcu, 0xffc1ffdfu, 0xff58ff95u); }
        case 17u: { v = vec4<u32>(0xfe96ff04u, 0xfd53fe07u, 0xfb70fc77u, 0xf8defa3du); }
        case 18u: { v = vec4<u32>(0xf5a8f756u, 0xf1e1f3d5u, 0xeda8efd1u, 0xe91ceb6bu); }
        case 19u: { v = vec4<u32>(0xe459e6bfu, 0xdf79e1ebu, 0xda92dd05u, 0xd5b5d821u); }
        case 20u: { v = vec4<u32>(0xffffffffu, 0xfff1fffbu, 0xffbeffdeu, 0xff53ff91u); }
        case 21u: { v = vec4<u32>(0xfe99ff02u, 0xfd6dfe14u, 0xfbaafca0u, 0xf93cfa89u); }
        case 22u: { v = vec4<u32>(0xf622f7c4u, 0xf26df459u, 0xee37f060u, 0xe99febf5u); }
        case 23u: { v = vec4<u32>(0xe4c4e738u, 0xdfc2e246u, 0xdab0dd39u, 0xd5a2d827u); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xfff1fffbu, 0xffbbffdcu, 0xff4dff8cu); }
        case 25u: { v = vec4<u32>(0xfe96fefcu, 0xfd77fe16u, 0xfbcefcb6u, 0xf980fabcu); }
        case 26u: { v = vec4<u32>(0xf682f816u, 0xf2dff4c4u, 0xeeaef0d6u, 0xea0cec69u); }
        case 27u: { v = vec4<u32>(0xe518e79au, 0xdff0e289u, 0xdaafdd51u, 0xd569d80bu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfff0fffbu, 0xffb8ffdau, 0xff46ff87u); }
        case 29u: { v = vec4<u32>(0xfe8efef4u, 0xfd77fe10u, 0xfbe1fcbeu, 0xf9abfadbu); }
        case 30u: { v = vec4<u32>(0xf6c7f84fu, 0xf336f513u, 0xef09f131u, 0xea5becc0u); }
        case 31u: { v = vec4<u32>(0xe54de7dfu, 0xdffde2acu, 0xda87dd45u, 0xd504d7c6u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfff0fffbu, 0xffb5ffd9u, 0xff3fff82u); }
        case 33u: { v = vec4<u32>(0xfe83feebu, 0xfd70fe06u, 0xfbe5fcbbu, 0xf9c3fae8u); }
        case 34u: { v = vec4<u32>(0xf6f3f871u, 0xf370f547u, 0xef45f16eu, 0xea8becf8u); }
        case 35u: { v = vec4<u32>(0xe560e802u, 0xdfe4e2aau, 0xda35dd11u, 0xd46ed753u); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xffeffffbu, 0xffb2ffd8u, 0xff38ff7du); }
        case 37u: { v = vec4<u32>(0xfe78fee1u, 0xfd63fdf9u, 0xfbdffcb1u, 0xf9c9fae8u); }
        case 38u: { v = vec4<u32>(0xf708f87fu, 0xf38ef562u, 0xef63f18eu, 0xea99ed10u); }
        case 39u: { v = vec4<u32>(0xe54de801u, 0xdfa0e280u, 0xd9b4dcb0u, 0xd3a5d6afu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xffeffffbu, 0xffb0ffd7u, 0xff31ff79u); }
        case 41u: { v = vec4<u32>(0xfe6bfed7u, 0xfd53fdebu, 0xfbd0fca1u, 0xf9c1fadcu); }
        case 42u: { v = vec4<u32>(0xf707f87bu, 0xf392f565u, 0xef60f190u, 0xea82ed05u); }
        case 43u: { v = vec4<u32>(0xe511e7dau, 0xdf31e22du, 0xd902dc21u, 0xd2a6d5d8u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffeffffbu, 0xffaeffd6u, 0xff2aff75u); }
        case 45u: { v = vec4<u32>(0xfe5ffeceu, 0xfd41fddbu, 0xfbbbfc8du, 0xf9acfac7u); }
        case 46u: { v = vec4<u32>(0xf6f5f867u, 0xf37df552u, 0xef3ff176u, 0xea47ecd9u); }
        case 47u: { v = vec4<u32>(0xe4ade78cu, 0xde93e1adu, 0xd81cdb60u, 0xd16ed4cau); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffeffffbu, 0xffacffd5u, 0xff25ff72u); }
        case 49u: { v = vec4<u32>(0xfe52fec5u, 0xfd2dfdcau, 0xfba0fc75u, 0xf98dfaaau); }
        case 50u: { v = vec4<u32>(0xf6d0f846u, 0xf34ff529u, 0xeefff141u, 0xe9e6ec8au); }
        case 51u: { v = vec4<u32>(0xe41ce716u, 0xddc3e0ffu, 0xd700da6cu, 0xcffbd383u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffeefffbu, 0xffabffd5u, 0xff1fff6eu); }
        case 53u: { v = vec4<u32>(0xfe45febcu, 0xfd17fdbau, 0xfb81fc5bu, 0xf964fa86u); }
        case 54u: { v = vec4<u32>(0xf69cf818u, 0xf30af4eeu, 0xee9ff0f0u, 0xe95fec19u); }
        case 55u: { v = vec4<u32>(0xe35fe675u, 0xdcc0e021u, 0xd5abd941u, 0xce4bd202u); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffeefffbu, 0xffa9ffd4u, 0xff19ff6bu); }
        case 57u: { v = vec4<u32>(0xfe39feb4u, 0xfd00fda8u, 0xfb5efc3eu, 0xf932fa5bu); }
        case 58u: { v = vec4<u32>(0xf657f7ddu, 0xf2adf49eu, 0xee20f084u, 0xe8b1eb85u); }
        case 59u: { v = vec4<u32>(0xe273e5aau, 0xdb87df10u, 0xd41ad7deu, 0xcc5ad041u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffeefffbu, 0xffa8ffd3u, 0xff14ff68u); }
        case 61u: { v = vec4<u32>(0xfe2cfeabu, 0xfce9fd97u, 0xfb36fc1fu, 0xf8f7fa2bu); }
        case 62u: { v = vec4<u32>(0xf604f796u, 0xf239f43bu, 0xed81effbu, 0xe7d9eacau); }
        case 63u: { v = vec4<u32>(0xe154e4b0u, 0xda15ddc9u, 0xd24bd63eu, 0xca26ce40u); }
        default: {}
      }
    }
    case 1u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xffffffffu, 0xffeefffbu, 0xffa6ffd3u, 0xff10ff66u); }
        case 1u: { v = vec4<u32>(0xfe20fea3u, 0xfccffd85u, 0xfb0bfbfdu, 0xf8b3f9f4u); }
        case 2u: { v = vec4<u32>(0xf59ff743u, 0xf1abf3c3u, 0xecbeef55u, 0xe6d5e9e9u); }
        case 3u: { v = vec4<u32>(0xe001e386u, 0xd867dc4au, 0xd039d45fu, 0xc7accbfbu); }
        case 4u: { v = vec4<u32>(0xffffffffu, 0xffeefffbu, 0xffa5ffd2u, 0xff0bff63u); }
        case 5u: { v = vec4<u32>(0xfe14fe9cu, 0xfcb5fd72u, 0xfadbfbd9u, 0xf864f9b6u); }
        case 6u: { v = vec4<u32>(0xf529f6e2u, 0xf102f335u, 0xebd7ee8eu, 0xe5a1e8ddu); }
        case 7u: { v = vec4<u32>(0xde75e228u, 0xd679da8eu, 0xcde0d23cu, 0xc4e7c96cu); }
        case 8u: { v = vec4<u32>(0xffffffffu, 0xffeefffbu, 0xffa4ffd2u, 0xff07ff61u); }
        case 9u: { v = vec4<u32>(0xfe07fe94u, 0xfc99fd5fu, 0xfaa5fbb2u, 0xf80bf970u); }
        case 10u: { v = vec4<u32>(0xf4a0f672u, 0xf03cf28fu, 0xeac7eda5u, 0xe43be7a3u); }
        case 11u: { v = vec4<u32>(0xdcace092u, 0xd444d890u, 0xcb3ccfd0u, 0xc1d3c690u); }
        case 12u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xffa3ffd2u, 0xff02ff5fu); }
        case 13u: { v = vec4<u32>(0xfdfafe8cu, 0xfc7afd4au, 0xfa6afb86u, 0xf7a5f920u); }
        case 14u: { v = vec4<u32>(0xf401f5f2u, 0xef56f1ceu, 0xe98bec95u, 0xe29ce637u); }
        case 15u: { v = vec4<u32>(0xdaa0debdu, 0xd1c4d64bu, 0xc847cd16u, 0xbe6bc360u); }
        case 16u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xffa2ffd1u, 0xfefeff5du); }
        case 17u: { v = vec4<u32>(0xfdecfe84u, 0xfc58fd34u, 0xfa26fb55u, 0xf72ff8c6u); }
        case 18u: { v = vec4<u32>(0xf349f55du, 0xee4bf0efu, 0xe81deb5bu, 0xe0bfe493u); }
        case 19u: { v = vec4<u32>(0xd84cdca5u, 0xcef3d3b8u, 0xc4faca06u, 0xbaa8bfd7u); }
        case 20u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xffa1ffd1u, 0xfef9ff5bu); }
        case 21u: { v = vec4<u32>(0xfdddfe7bu, 0xfc32fd1bu, 0xf9d9fb1eu, 0xf6a8f85eu); }
        case 22u: { v = vec4<u32>(0xf274f4b1u, 0xed16efecu, 0xe678e9efu, 0xde9de2b1u); }
        case 23u: { v = vec4<u32>(0xd5a5da42u, 0xcbc7d0cfu, 0xc14cc699u, 0xb682bbecu); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xffa1ffd1u, 0xfef5ff58u); }
        case 25u: { v = vec4<u32>(0xfdcbfe71u, 0xfc06fcfeu, 0xf980fadeu, 0xf60cf7e6u); }
        case 26u: { v = vec4<u32>(0xf17df3eau, 0xebb0eec0u, 0xe493e84cu, 0xdc2de087u); }
        case 27u: { v = vec4<u32>(0xd2a5d78au, 0xc839cd87u, 0xbd36c2c5u, 0xb1f1b797u); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xffa0ffd1u, 0xfeefff56u); }
        case 29u: { v = vec4<u32>(0xfdb7fe66u, 0xfbd3fcdeu, 0xf917fa93u, 0xf554f75au); }
        case 30u: { v = vec4<u32>(0xf05ef302u, 0xea12ed64u, 0xe264e667u, 0xd964de0cu); }
        case 31u: { v = vec4<u32>(0xcf3fd472u, 0xc43ac9d3u, 0xb8acbe7fu, 0xaceab2ccu); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xff9fffd0u, 0xfee8ff53u); }
        case 33u: { v = vec4<u32>(0xfda0fe59u, 0xfb97fcb6u, 0xf89cfa3bu, 0xf47df6b4u); }
        case 34u: { v = vec4<u32>(0xef0df1f1u, 0xe830ebcdu, 0xdfe0e435u, 0xd634db33u); }
        case 35u: { v = vec4<u32>(0xcb65d0edu, 0xbfbfc5a7u, 0xb39fb9b9u, 0xa762ad7fu); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xff9effd0u, 0xfee0ff50u); }
        case 37u: { v = vec4<u32>(0xfd82fe49u, 0xfb4dfc86u, 0xf807f9d0u, 0xf37cf5edu); }
        case 38u: { v = vec4<u32>(0xed80f0aeu, 0xe5fde9f0u, 0xdcf6e1a9u, 0xd28ed7ebu); }
        case 39u: { v = vec4<u32>(0xc706cce9u, 0xbab5c0f0u, 0xae00b461u, 0xa146a79eu); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xff9cffd0u, 0xfed5ff4bu); }
        case 41u: { v = vec4<u32>(0xfd5dfe33u, 0xfaf1fc4au, 0xf752f94cu, 0xf247f4fdu); }
        case 42u: { v = vec4<u32>(0xeba9ef2cu, 0xe368e7bdu, 0xd993deaeu, 0xce5ad41fu); }
        case 43u: { v = vec4<u32>(0xc20ac850u, 0xb506bb98u, 0xa7b8ae62u, 0x9a85a115u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xff99ffcfu, 0xfec7ff44u); }
        case 45u: { v = vec4<u32>(0xfd2cfe17u, 0xfa7cfbfbu, 0xf670f8a5u, 0xf0cdf3d4u); }
        case 46u: { v = vec4<u32>(0xe972ed58u, 0xe058e51cu, 0xd59cdb2bu, 0xc97dcfb4u); }
        case 47u: { v = vec4<u32>(0xbc56c304u, 0xae95b581u, 0xa0aca79eu, 0x930299c9u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xffedfffbu, 0xff96ffceu, 0xfeb1ff3au); }
        case 49u: { v = vec4<u32>(0xfce8fdefu, 0xf9e1fb92u, 0xf54ef7ceu, 0xeef6f25du); }
        case 50u: { v = vec4<u32>(0xe6bdeb16u, 0xdcaae1edu, 0xd0ead6fbu, 0xc3ccca80u); }
        case 51u: { v = vec4<u32>(0xb5bebcdcu, 0xa738ae82u, 0x98b39feeu, 0x8a999193u); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xffecfffau, 0xff8fffccu, 0xfe8fff2au); }
        case 53u: { v = vec4<u32>(0xfc85fdb2u, 0xf90cfafcu, 0xf3cff6aau, 0xec9af076u); }
        case 54u: { v = vec4<u32>(0xe35ae83bu, 0xd827ddfcu, 0xcb40d1e4u, 0xbd0bc448u); }
        case 55u: { v = vec4<u32>(0xae04b599u, 0x9eb2a65du, 0x8f949716u, 0x8114883bu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xffebfffau, 0xff80ffc7u, 0xfe52ff09u); }
        case 57u: { v = vec4<u32>(0xfbe6fd4bu, 0xf7cefa15u, 0xf1b6f506u, 0xe96eedd9u); }
        case 58u: { v = vec4<u32>(0xdef3e475u, 0xd26fd8edu, 0xc43acb83u, 0xb4cfbca2u); }
        case 59u: { v = vec4<u32>(0xa4bfacd2u, 0x949d9ca8u, 0x84ec8cafu, 0x76157d5fu); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xffe8fffau, 0xff66ffbcu, 0xfdfcfed7u); }
        case 61u: { v = vec4<u32>(0xfb27fcc6u, 0xf678f911u, 0xef9cf353u, 0xe66ceb4fu); }
        case 62u: { v = vec4<u32>(0xdaefe0f4u, 0xcd5fd464u, 0xbe27c5f0u, 0xadd4b617u); }
        case 63u: { v = vec4<u32>(0x9d04a571u, 0x8c51949du, 0x7c43842eu, 0x6d3e749au); }
        default: {}
      }
    }
    case 2u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 1u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 2u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 3u: { v = vec4<u32>(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu); }
        case 4u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff69ffb2u, 0xfe91ff08u); }
        case 5u: { v = vec4<u32>(0xfd55fe01u, 0xfb97fc88u, 0xf947fa82u, 0xf665f7e8u); }
        case 6u: { v = vec4<u32>(0xf2fef4c1u, 0xef2af120u, 0xeb02ed1fu, 0xe69fe8d6u); }
        case 7u: { v = vec4<u32>(0xe21ae45fu, 0xdd89dfd2u, 0xd8fcdb41u, 0xd484d6bdu); }
        case 8u: { v = vec4<u32>(0xfffeffffu, 0xffdefff7u, 0xff3fffa3u, 0xfdf2feadu); }
        case 9u: { v = vec4<u32>(0xfc1efd16u, 0xf9e9fb0fu, 0xf74ef8a9u, 0xf442f5d6u); }
        case 10u: { v = vec4<u32>(0xf0c4f291u, 0xece2eedfu, 0xe8b1ead2u, 0xe446e681u); }
        case 11u: { v = vec4<u32>(0xdfbae203u, 0xdb21dd6eu, 0xd68cd8d5u, 0xd20bd449u); }
        case 12u: { v = vec4<u32>(0xfffeffffu, 0xffdcfff7u, 0xff2dff9eu, 0xfd95fe7fu); }
        case 13u: { v = vec4<u32>(0xfb20fc71u, 0xf821f9adu, 0xf4d3f682u, 0xf144f314u); }
        case 14u: { v = vec4<u32>(0xed6fef62u, 0xe955eb6au, 0xe4fde72fu, 0xe078e2bfu); }
        case 15u: { v = vec4<u32>(0xdbd7de2au, 0xd72cd982u, 0xd286d4d7u, 0xcdf4d03bu); }
        case 16u: { v = vec4<u32>(0xfffeffffu, 0xffdbfff7u, 0xff23ff9bu, 0xfd5dfe66u); }
        case 17u: { v = vec4<u32>(0xfa6efc08u, 0xf6a3f89du, 0xf268f48eu, 0xee01f038u); }
        case 18u: { v = vec4<u32>(0xe982ebc5u, 0xe4ece73au, 0xe03de297u, 0xdb78dddcu); }
        case 19u: { v = vec4<u32>(0xd6a8d911u, 0xd1d7d43fu, 0xcd13cf73u, 0xc865cab8u); }
        case 20u: { v = vec4<u32>(0xfffeffffu, 0xffdbfff7u, 0xff1dff99u, 0xfd3cfe58u); }
        case 21u: { v = vec4<u32>(0xf9f5fbc4u, 0xf57ef7d9u, 0xf051f2f5u, 0xeae3ed9cu); }
        case 22u: { v = vec4<u32>(0xe575e82au, 0xe01ce2c6u, 0xdad6dd77u, 0xd5a1d83au); }
        case 23u: { v = vec4<u32>(0xd07bd30cu, 0xcb69cdefu, 0xc66fc8e9u, 0xc194c3fdu); }
        case 24u: { v = vec4<u32>(0xfffeffffu, 0xffdbfff7u, 0xff1bff98u, 0xfd28fe50u); }
        case 25u: { v = vec4<u32>(0xf9a6fb9au, 0xf4a7f750u, 0xeea0f1bbu, 0xe823eb68u); }
        case 26u: { v = vec4<u32>(0xe19ee4ddu, 0xdb48de6cu, 0xd530d833u, 0xcf52d23au); }
        case 27u: { v = vec4<u32>(0xc9aacc78u, 0xc432c6e8u, 0xbee6c186u, 0xb9c9bc52u); }
        case 28u: { v = vec4<u32>(0xfffeffffu, 0xffdbfff7u, 0xff1aff98u, 0xfd1dfe4cu); }
        case 29u: { v = vec4<u32>(0xf973fb82u, 0xf40ff6f5u, 0xed52f0d3u, 0xe5d7e9a3u); }
        case 30u: { v = vec4<u32>(0xde30e202u, 0xd6b9da6bu, 0xcf9ed31fu, 0xc8e7cc37u); }
        case 31u: { v = vec4<u32>(0xc28ec5b0u, 0xbc87bf81u, 0xb6cbb9a0u, 0xb153b407u); }
        case 32u: { v = vec4<u32>(0xfffeffffu, 0xffdbfff7u, 0xff1aff99u, 0xfd19fe4cu); }
        case 33u: { v = vec4<u32>(0xf956fb75u, 0xf3aaf6bbu, 0xec5cf02fu, 0xe402e846u); }
        case 34u: { v = vec4<u32>(0xdb44dfa6u, 0xd2a1d6e9u, 0xca65ce73u, 0xc2acc678u); }
        case 35u: { v = vec4<u32>(0xbb77bf02u, 0xb4bdb80cu, 0xae6fb189u, 0xa882ab6du); }
        case 36u: { v = vec4<u32>(0xfffeffffu, 0xffdbfff7u, 0xff1cff99u, 0xfd1afe4du); }
        case 37u: { v = vec4<u32>(0xf949fb71u, 0xf36cf69cu, 0xebb0efc3u, 0xe29de747u); }
        case 38u: { v = vec4<u32>(0xd8e2ddcau, 0xcf1ad3f8u, 0xc5b1ca55u, 0xbcddc132u); }
        case 39u: { v = vec4<u32>(0xb4adb8b0u, 0xad1db0d2u, 0xa61ea98cu, 0x9fa1a2d0u); }
        case 40u: { v = vec4<u32>(0xfffeffffu, 0xffdcfff7u, 0xff1dff9au, 0xfd1efe50u); }
        case 41u: { v = vec4<u32>(0xf948fb75u, 0xf34df690u, 0xeb42ef84u, 0xe19be698u); }
        case 42u: { v = vec4<u32>(0xd706dc63u, 0xcc2fd199u, 0xc19cc6d7u, 0xb7a2bc89u); }
        case 43u: { v = vec4<u32>(0xae63b2eau, 0xa5e4aa0cu, 0x9e1ca1eau, 0x96f89a76u); }
        case 44u: { v = vec4<u32>(0xfffeffffu, 0xffdcfff7u, 0xff20ff9bu, 0xfd24fe55u); }
        case 45u: { v = vec4<u32>(0xf950fb7du, 0xf345f694u, 0xeb05ef68u, 0xe0eee62bu); }
        case 46u: { v = vec4<u32>(0xd5a4db64u, 0xc9ddcfc5u, 0xbe35c3fdu, 0xb317b890u); }
        case 47u: { v = vec4<u32>(0xa8c0add1u, 0x9f44a3e6u, 0x969f9ad8u, 0x8ec39299u); }
        case 48u: { v = vec4<u32>(0xfffeffffu, 0xffddfff7u, 0xff23ff9cu, 0xfd2dfe5au); }
        case 49u: { v = vec4<u32>(0xf95efb89u, 0xf350f6a3u, 0xeaf0ef68u, 0xe089e5f5u); }
        case 50u: { v = vec4<u32>(0xd4b0dac0u, 0xc81cce72u, 0xbb78c1c3u, 0xaf48b54bu); }
        case 51u: { v = vec4<u32>(0xa3dca976u, 0x995d9e7eu, 0x8fd2947au, 0x87308b64u); }
        case 52u: { v = vec4<u32>(0xfffeffffu, 0xffddfff7u, 0xff26ff9eu, 0xfd36fe5fu); }
        case 53u: { v = vec4<u32>(0xf972fb97u, 0xf369f6bau, 0xeafbef7du, 0xe05ee5ebu); }
        case 54u: { v = vec4<u32>(0xd41ada66u, 0xc6decd8fu, 0xb95fc01cu, 0xac33b2b7u); }
        case 55u: { v = vec4<u32>(0x9fc1a5deu, 0x944499e2u, 0x89ce8ee8u, 0x806284f8u); }
        case 56u: { v = vec4<u32>(0xfffeffffu, 0xffddfff7u, 0xff29ff9fu, 0xfd41fe65u); }
        case 57u: { v = vec4<u32>(0xf989fba7u, 0xf38cf6d8u, 0xeb1defa2u, 0xe062e604u); }
        case 58u: { v = vec4<u32>(0xd3d1da4bu, 0xc612cd0bu, 0xb7dbbefau, 0xa9d1b0c7u); }
        case 59u: { v = vec4<u32>(0x9c6da304u, 0x8ffe9614u, 0x84a78a2fu, 0x7a6f7f67u); }
        case 60u: { v = vec4<u32>(0xfffeffffu, 0xffdefff8u, 0xff2cffa0u, 0xfd4cfe6cu); }
        case 61u: { v = vec4<u32>(0xf9a1fbb9u, 0xf3b6f6f9u, 0xeb51efd3u, 0xe08be636u); }
        case 62u: { v = vec4<u32>(0xd3c8da60u, 0xc5a6ccd8u, 0xb6dabe4au, 0xa812af6cu); }
        case 63u: { v = vec4<u32>(0x99d8a0ddu, 0x8c8a9310u, 0x805d864eu, 0x75627ab9u); }
        default: {}
      }
    }
    case 3u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfffeffffu, 0xffdefff8u, 0xff2fffa2u, 0xfd57fe72u); }
        case 1u: { v = vec4<u32>(0xf9bcfbcau, 0xf3e4f71du, 0xeb91f00cu, 0xe0cee67au); }
        case 2u: { v = vec4<u32>(0xd3f0da9bu, 0xc589cce3u, 0xb64abdf9u, 0xa6e6ae92u); }
        case 3u: { v = vec4<u32>(0x97f29f56u, 0x89dd90c7u, 0x7ceb833du, 0x713976e9u); }
        case 4u: { v = vec4<u32>(0xfffeffffu, 0xffdffff8u, 0xff32ffa3u, 0xfd62fe78u); }
        case 5u: { v = vec4<u32>(0xf9d6fbdcu, 0xf415f742u, 0xebdaf048u, 0xe124e6ccu); }
        case 6u: { v = vec4<u32>(0xd43ddaf0u, 0xc5aacd1fu, 0xb616bdf5u, 0xa635ae25u); }
        case 7u: { v = vec4<u32>(0x96a69e5bu, 0x87e58f26u, 0x7a4380edu, 0x6dea73ecu); }
        case 8u: { v = vec4<u32>(0xfffeffffu, 0xffdffff8u, 0xff35ffa4u, 0xfd6cfe7eu); }
        case 9u: { v = vec4<u32>(0xf9f0fbedu, 0xf446f767u, 0xec26f087u, 0xe187e724u); }
        case 10u: { v = vec4<u32>(0xd4a5db58u, 0xc5facd7fu, 0xb62bbe2cu, 0xa5ebae0eu); }
        case 11u: { v = vec4<u32>(0x95df9dd5u, 0x868d8e18u, 0x78537f49u, 0x6b6671b1u); }
        case 12u: { v = vec4<u32>(0xfffeffffu, 0xffdffff8u, 0xff37ffa5u, 0xfd76fe84u); }
        case 13u: { v = vec4<u32>(0xfa09fbfeu, 0xf477f78bu, 0xec74f0c6u, 0xe1efe780u); }
        case 14u: { v = vec4<u32>(0xd51ddbcau, 0xc66ccdf7u, 0xb678be8fu, 0xa5f2ae3cu); }
        case 15u: { v = vec4<u32>(0x95859daeu, 0x85bc8d84u, 0x77027e39u, 0x6995701fu); }
        case 16u: { v = vec4<u32>(0xfffeffffu, 0xffe0fff8u, 0xff3affa6u, 0xfd80fe89u); }
        case 17u: { v = vec4<u32>(0xfa21fc0du, 0xf4a5f7adu, 0xecbff103u, 0xe259e7dbu); }
        case 18u: { v = vec4<u32>(0xd59edc41u, 0xc6f2ce7eu, 0xb6ebbf10u, 0xa636ae9cu); }
        case 19u: { v = vec4<u32>(0x957f9dd1u, 0x855a8d52u, 0x76377da3u, 0x685e6f1eu); }
        case 20u: { v = vec4<u32>(0xfffeffffu, 0xffe0fff8u, 0xff3cffa7u, 0xfd89fe8eu); }
        case 21u: { v = vec4<u32>(0xfa37fc1cu, 0xf4d1f7cdu, 0xed07f13cu, 0xe2c1e833u); }
        case 22u: { v = vec4<u32>(0xd620dcb7u, 0xc783cf09u, 0xb776bfa0u, 0xa6a5af1bu); }
        case 23u: { v = vec4<u32>(0x95b99e28u, 0x854d8d6bu, 0x75d87d6eu, 0x67a76e93u); }
        case 24u: { v = vec4<u32>(0xfffeffffu, 0xffe0fff8u, 0xff3fffa8u, 0xfd91fe92u); }
        case 25u: { v = vec4<u32>(0xfa4bfc29u, 0xf4f9f7eau, 0xed4af171u, 0xe323e885u); }
        case 26u: { v = vec4<u32>(0xd69fdd28u, 0xc815cf93u, 0xb80dc037u, 0xa72cafadu); }
        case 27u: { v = vec4<u32>(0x961e9ea0u, 0x857f8db8u, 0x75ca7d81u, 0x67546e63u); }
        case 28u: { v = vec4<u32>(0xfffeffffu, 0xffe0fff8u, 0xff41ffa9u, 0xfd98fe96u); }
        case 29u: { v = vec4<u32>(0xfa5dfc35u, 0xf51df804u, 0xed87f1a0u, 0xe37ce8d0u); }
        case 30u: { v = vec4<u32>(0xd714dd90u, 0xc8a1d015u, 0xb8a4c0cau, 0xa7beb043u); }
        case 31u: { v = vec4<u32>(0x969b9f2au, 0x85d88e25u, 0x75f57dc4u, 0x674a6e74u); }
        case 32u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff42ffaau, 0xfd9efe9au); }
        case 33u: { v = vec4<u32>(0xfa6dfc3fu, 0xf53cf81bu, 0xedbcf1cau, 0xe3cbe912u); }
        case 34u: { v = vec4<u32>(0xd77eddecu, 0xc921d08bu, 0xb933c153u, 0xa84fb0d5u); }
        case 35u: { v = vec4<u32>(0x97219fb7u, 0x86478ea1u, 0x76437e24u, 0x67726eb0u); }
        case 36u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff44ffaau, 0xfda3fe9cu); }
        case 37u: { v = vec4<u32>(0xfa7afc48u, 0xf557f82eu, 0xede9f1edu, 0xe40fe949u); }
        case 38u: { v = vec4<u32>(0xd7d9de3cu, 0xc991d0f1u, 0xb9b2c1cbu, 0xa8d5b158u); }
        case 39u: { v = vec4<u32>(0x97a3a03cu, 0x86bb8f1du, 0x76a17e8du, 0x67b66f01u); }
        case 40u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff45ffabu, 0xfda8fe9fu); }
        case 41u: { v = vec4<u32>(0xfa85fc4fu, 0xf56df83eu, 0xee0ef20au, 0xe445e977u); }
        case 42u: { v = vec4<u32>(0xd823de7cu, 0xc9eed145u, 0xba1dc230u, 0xa947b1c8u); }
        case 43u: { v = vec4<u32>(0x9816a0b0u, 0x87278f8du, 0x77007ef3u, 0x68026f57u); }
        case 44u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff46ffabu, 0xfdabfea1u); }
        case 45u: { v = vec4<u32>(0xfa8efc54u, 0xf57ef84au, 0xee2af220u, 0xe470e99au); }
        case 46u: { v = vec4<u32>(0xd85cdeaeu, 0xca36d185u, 0xba70c27eu, 0xa9a3b220u); }
        case 47u: { v = vec4<u32>(0x9873a10du, 0x87818feau, 0x77537f4bu, 0x684b6fa5u); }
        case 48u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff47ffabu, 0xfdaefea2u); }
        case 49u: { v = vec4<u32>(0xfa94fc58u, 0xf58af853u, 0xee3ef22fu, 0xe48de9b3u); }
        case 50u: { v = vec4<u32>(0xd885ded1u, 0xca68d1b3u, 0xbaabc2b5u, 0xa9e4b25eu); }
        case 51u: { v = vec4<u32>(0x98b7a150u, 0x87c4902du, 0x77927f8cu, 0x68846fe2u); }
        case 52u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff47ffacu, 0xfdaffea3u); }
        case 53u: { v = vec4<u32>(0xfa98fc5bu, 0xf591f858u, 0xee4af239u, 0xe49fe9c2u); }
        case 54u: { v = vec4<u32>(0xd89ddee6u, 0xca86d1ceu, 0xbacec2d6u, 0xaa0bb284u); }
        case 55u: { v = vec4<u32>(0x98e0a178u, 0x87ee9057u, 0x77ba7fb5u, 0x68a97008u); }
        case 56u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff47ffacu, 0xfdb0fea4u); }
        case 57u: { v = vec4<u32>(0xfa9afc5cu, 0xf594f85bu, 0xee50f23du, 0xe4a7e9c8u); }
        case 58u: { v = vec4<u32>(0xd8a7deefu, 0xca93d1dau, 0xbadec2e4u, 0xaa1cb294u); }
        case 59u: { v = vec4<u32>(0x98f3a18au, 0x88009069u, 0x77cc7fc7u, 0x68ba701au); }
        case 60u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff47ffacu, 0xfdb0fea4u); }
        case 61u: { v = vec4<u32>(0xfa9afc5du, 0xf595f85bu, 0xee51f23eu, 0xe4a8e9cau); }
        case 62u: { v = vec4<u32>(0xd8a9def1u, 0xca96d1dcu, 0xbae1c2e7u, 0xaa1fb297u); }
        case 63u: { v = vec4<u32>(0x98f6a18du, 0x8803906cu, 0x77cf7fcau, 0x68bd701du); }
        default: {}
      }
    }
    default: {}
  }
  if (lane == 0u) { return v.x; }
  if (lane == 1u) { return v.y; }
  if (lane == 2u) { return v.z; }
  return v.w;
}

struct BsdfGlassFresnel {
  reflectance: vec3<f32>,
  transmittance: vec3<f32>,
  cos_theta_t: f32,
}

fn bsdf_glass_read_e(x: f32, y: f32, z: f32, inverse_table: bool) -> f32 {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let sy = clamp(y, 0.0, 1.0) * 31.0;
  let sz = clamp(z, 0.0, 1.0) * 31.0;
  let x0 = min(u32(sx), 31u);
  let x1 = min(x0 + 1u, 31u);
  let y0 = min(u32(sy), 31u);
  let y1 = min(y0 + 1u, 31u);
  let z0 = min(u32(sz), 31u);
  let z1 = min(z0 + 1u, 31u);
  let tx = sx - f32(x0);
  let ty = sy - f32(y0);
  let tz = sz - f32(z0);
  let base_word = select(0u, 8192u, inverse_table);
  let limit = 8u + bsdf_mf_zero_guard();
  var res = 0.0;
  for (var corner: u32 = 0u; corner < limit; corner = corner + 1u) {
    let cx = select(x0, x1, (corner & 1u) != 0u);
    let cy = select(y0, y1, (corner & 2u) != 0u);
    let cz = select(z0, z1, (corner & 4u) != 0u);
    let wx = select(1.0 - tx, tx, (corner & 1u) != 0u);
    let wy = select(1.0 - ty, ty, (corner & 2u) != 0u);
    let wz = select(1.0 - tz, tz, (corner & 4u) != 0u);
    let byte_idx = (cz * 32u + cy) * 32u + cx;
    let word = bsdf_glass_lut_e_u32(base_word + (byte_idx >> 2u));
    let val = f32((word >> ((byte_idx & 3u) * 8u)) & 0xFFu) * BSDF_GLASS_INV_255;
    res = res + (wx * wy * wz) * val;
  }
  return res;
}

fn bsdf_glass_read_eavg(x: f32, z: f32, inverse_table: bool) -> f32 {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let sz = clamp(z, 0.0, 1.0) * 31.0;
  let x0 = min(u32(sx), 31u);
  let x1 = min(x0 + 1u, 31u);
  let z0 = min(u32(sz), 31u);
  let z1 = min(z0 + 1u, 31u);
  let tx = sx - f32(x0);
  let tz = sz - f32(z0);
  let base_word = select(0u, 512u, inverse_table);
  let limit = 4u + bsdf_mf_zero_guard();
  var res = 0.0;
  for (var corner: u32 = 0u; corner < limit; corner = corner + 1u) {
    let cx = select(x0, x1, (corner & 1u) != 0u);
    let cz = select(z0, z1, (corner & 2u) != 0u);
    let wx = select(1.0 - tx, tx, (corner & 1u) != 0u);
    let wz = select(1.0 - tz, tz, (corner & 2u) != 0u);
    let elem_idx = cz * 32u + cx;
    let word = bsdf_glass_lut_eavg_u32(base_word + (elem_idx >> 1u));
    let val = f32((word >> ((elem_idx & 1u) * 16u)) & 0xFFFFu) * BSDF_GLASS_INV_65535;
    res = res + (wx * wz) * val;
  }
  return res;
}

fn bsdf_glass_refract_angle(incident: vec3<f32>, normal: vec3<f32>, cos_theta_t: f32, inv_eta: f32) -> vec3<f32> {
  return (inv_eta * dot(normal, incident) + cos_theta_t) * normal - inv_eta * incident;
}

fn bsdf_glass_fresnel(lobe: Lobe, cos_theta_i: f32) -> BsdfGlassFresnel {
  let eval4 = bsdf_mf_generalized_schlick_eval(
    lobe.f0,
    lobe.ior,
    lobe.thin_film_thickness,
    lobe.thin_film_ior,
    cos_theta_i,
  );
  let refl = clamp(eval4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  let trans = lobe.f82_or_tint * (vec3<f32>(1.0) - refl);
  return BsdfGlassFresnel(refl, trans, eval4.w);
}

fn bsdf_glass_preserve_energy(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
  eta: f32,
  fss: vec3<f32>,
) -> vec4<f32> {
  let coords = bsdf_mf_albedo_coords(normal, tangent, wo, alpha_x, alpha_y);
  let rough_avg = bsdf_mf_albedo_avg_roughness(alpha_x, alpha_y);
  let is_inv = eta < 1.0;
  let lookup_ior = select(eta, 1.0 / max(eta, 1e-5), is_inv);
  let z = bsdf_mf_ior_to_z_index(lookup_ior);
  let e_dir = max(bsdf_glass_read_e(coords.x, coords.y, z, is_inv), 1e-4);
  let e_avg = clamp(bsdf_glass_read_eavg(rough_avg, z, is_inv), 1e-4, 1.0);
  let missing_factor = (1.0 - e_dir) / e_dir;
  let energy_scale = 1.0 + missing_factor;
  if (all(fss == vec3<f32>(1.0))) {
    return vec4<f32>(vec3<f32>(1.0), energy_scale);
  }
  let denom = max(vec3<f32>(1.0) - fss * (1.0 - e_avg), vec3<f32>(1e-6));
  let fms = fss * e_avg / denom;
  let darkening = (vec3<f32>(1.0) + fms * missing_factor) / energy_scale;
  return vec4<f32>(darkening, energy_scale);
}

fn bsdf_glass_setup_lobe(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  weight: vec3<f32>,
  material_ior: f32,
  front_face: u32,
  reflection_tint: vec3<f32>,
  transmission_tint: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  preserve_energy: bool,
) -> Lobe {
  var lobe: Lobe;
  let ax = clamp(alpha_x, 0.0, 1.0);
  let ay = clamp(alpha_y, 0.0, 1.0);
  let safe_ior = max(material_ior, 1e-5);
  let eta = select(1.0 / safe_ior, safe_ior, front_face != 0u);
  let f0 = clamp(bsdf_mf_f0_from_ior(safe_ior) * max(reflection_tint, vec3<f32>(0.0)), vec3<f32>(0.0), vec3<f32>(1.0));
  let trans_tint = clamp(transmission_tint, vec3<f32>(0.0), vec3<f32>(1.0));

  var adj_film_ior = max(thin_film_ior, 1e-5);
  if (front_face == 0u) {
    adj_film_ior = adj_film_ior * eta;
  }

  var flags = 0u;
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    flags = flags | LOBE_FLAG_THIN_FILM;
  }

  lobe.weight = weight;
  lobe.sample_weight = bsdf_mf_average(weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_GLASS_GGX;
  lobe.tangent = tangent;
  lobe.flags = flags;
  lobe.f0 = f0;
  lobe.ior = eta;
  lobe.f82_or_tint = trans_tint;
  lobe.diffuse_roughness = 1.0;
  lobe.alpha_x = ax;
  lobe.alpha_y = ay;
  lobe.thin_film_thickness = select(0.0, thin_film_thickness, thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);
  lobe.thin_film_ior = select(0.0, adj_film_ior, thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);

  let cos_no = max(dot(wo, normal), 0.0);
  var albedo_est = vec3<f32>(1.0);
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    let fr = bsdf_glass_fresnel(lobe, cos_no);
    albedo_est = fr.reflectance + fr.transmittance;
  } else {
    let coords = bsdf_mf_albedo_coords(normal, tangent, wo, ax, ay);
    let z = bsdf_mf_ior_to_z_index(eta);
    let s = bsdf_mf_read_gen_schlick_ior_s(coords.x, coords.y, z);
    let f_est = mix(f0, vec3<f32>(1.0), s);
    albedo_est = f_est + trans_tint * (vec3<f32>(1.0) - f_est);
  }
  lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(albedo_est);

  if (preserve_energy) {
    lobe.flags = lobe.flags | LOBE_FLAG_MULTISCATTER;
    let pres = bsdf_glass_preserve_energy(normal, tangent, wo, ax, ay, eta, trans_tint);
    lobe.weight = lobe.weight * pres.xyz;
    lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(pres.xyz);
    lobe.diffuse_roughness = pres.w;
  }
  return lobe;
}

fn bsdf_glass_eval(lobe: Lobe, wi: vec3<f32>, wo: vec3<f32>) -> BsdfMfEval {
  let cos_no = dot(lobe.normal, wo);
  let cos_ni = dot(lobe.normal, wi);
  if (cos_no <= 0.0 || cos_ni == 0.0 || bsdf_mf_is_singular(lobe.alpha_x, lobe.alpha_y)) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  let is_transmission = cos_ni < 0.0;
  let eta = lobe.ior;
  if (is_transmission && abs(eta - 1.0) < 1e-4) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  var raw_h = wo + wi;
  if (is_transmission) {
    raw_h = select(-(eta * wi + wo), eta * wi + wo, eta < 1.0);
  }
  let len_h_sq = dot(raw_h, raw_h);
  if (len_h_sq <= 1e-16) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let inv_len_h = inverseSqrt(len_h_sq);
  let half_vec = raw_h * inv_len_h;

  let cos_nh = dot(lobe.normal, half_vec);
  let cos_ho = dot(half_vec, wo);
  let cos_hi = dot(half_vec, wi);
  if (cos_nh <= 0.0 || cos_ho <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  if (is_transmission && cos_hi >= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  let coeff = bsdf_glass_fresnel(lobe, cos_ho);
  let sum_avg = bsdf_mf_average(coeff.reflectance + coeff.transmittance);
  if (sum_avg <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  var ndf = 0.0;
  var lambda_wo = 0.0;
  var lambda_wi = 0.0;
  if (lobe.alpha_x == lobe.alpha_y) {
    let alpha2 = lobe.alpha_x * lobe.alpha_y;
    let cross_nh = cross(lobe.normal, half_vec);
    ndf = bsdf_mf_d(alpha2, cos_nh, dot(cross_nh, cross_nh));
    lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
    lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  } else {
    let frame = bsdf_mf_make_orthonormals_tangent(lobe.normal, lobe.tangent);
    let local_h = vec3<f32>(dot(frame[0], half_vec), dot(frame[1], half_vec), cos_nh);
    let local_wo = vec3<f32>(dot(frame[0], wo), dot(frame[1], wo), cos_no);
    let local_wi = vec3<f32>(dot(frame[0], wi), dot(frame[1], wi), cos_ni);
    ndf = bsdf_mf_aniso_d(lobe.alpha_x, lobe.alpha_y, local_h);
    lambda_wo = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wo);
    lambda_wi = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wi);
  }

  var jacobian = 0.25;
  if (is_transmission) {
    jacobian = bsdf_mf_sqr(eta * inv_len_h) * abs(cos_ho * cos_hi);
  }
  let common_factor = (ndf / cos_no) * jacobian;
  let pdf_reflect = bsdf_mf_average(coeff.reflectance) / sum_avg;
  let lobe_pdf = select(pdf_reflect, 1.0 - pdf_reflect, is_transmission);
  let pdf = common_factor * lobe_pdf / (1.0 + lambda_wo);
  if (pdf <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let spec_weight = select(coeff.reflectance, coeff.transmittance, is_transmission);
  let energy_scale = lobe.diffuse_roughness;
  let value = lobe.weight * spec_weight * (energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi));
  return BsdfMfEval(value, pdf);
}

fn bsdf_glass_sample(
  lobe: Lobe,
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  rand_xy: vec2<f32>,
  rand_lobe: f32,
) -> BsdfMfSample {
  let cos_no = dot(lobe.normal, wo);
  if (cos_no <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  var singular = bsdf_mf_is_singular(lobe.alpha_x, lobe.alpha_y);
  var half_vec = lobe.normal;
  var frame = mat2x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0));
  var local_wo = vec3<f32>(0.0, 0.0, cos_no);
  var local_h = vec3<f32>(0.0, 0.0, 1.0);

  if (!singular) {
    if (lobe.alpha_x == lobe.alpha_y) {
      frame = bsdf_mf_make_orthonormals(lobe.normal);
    } else {
      frame = bsdf_mf_make_orthonormals_tangent(lobe.normal, lobe.tangent);
    }
    local_wo = vec3<f32>(dot(frame[0], wo), dot(frame[1], wo), cos_no);
    local_h = bsdf_mf_sample_vndf(local_wo, lobe.alpha_x, lobe.alpha_y, rand_xy);
    half_vec = local_h.x * frame[0] + local_h.y * frame[1] + local_h.z * lobe.normal;
  }

  let cos_ho = dot(half_vec, wo);
  if (cos_ho <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let coeff = bsdf_glass_fresnel(lobe, cos_ho);
  let sum_avg = bsdf_mf_average(coeff.reflectance + coeff.transmittance);
  if (sum_avg <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let pdf_reflect = bsdf_mf_average(coeff.reflectance) / sum_avg;
  let do_refract = rand_lobe >= pdf_reflect;
  let eta = lobe.ior;
  let inv_eta = 1.0 / max(eta, 1e-6);

  var wi = 2.0 * cos_ho * half_vec - wo;
  if (do_refract) {
    wi = bsdf_glass_refract_angle(wo, half_vec, coeff.cos_theta_t, inv_eta);
  }

  let cos_ni = dot(lobe.normal, wi);
  let cos_ngi = dot(geometric_normal, wi);
  if ((cos_ngi < 0.0) != do_refract || (cos_ni < 0.0) != do_refract || cos_ni == 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  var spec_weight = coeff.reflectance;
  var branch_pdf = pdf_reflect;
  if (do_refract) {
    spec_weight = coeff.transmittance;
    branch_pdf = 1.0 - pdf_reflect;
    singular = singular || (abs(eta - 1.0) < 1e-4);
  }
  if (branch_pdf <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let energy_scale = lobe.diffuse_roughness;
  if (singular) {
    let throughput = lobe.weight * (spec_weight / branch_pdf) * energy_scale;
    return BsdfMfSample(wi, BSDF_GLASS_SINGULAR_WEIGHT, throughput * BSDF_GLASS_SINGULAR_WEIGHT, true);
  }

  var ndf = 0.0;
  var lambda_wo = 0.0;
  var lambda_wi = 0.0;
  if (lobe.alpha_x == lobe.alpha_y) {
    let alpha2 = lobe.alpha_x * lobe.alpha_y;
    ndf = bsdf_mf_d(alpha2, local_h.z, local_h.x * local_h.x + local_h.y * local_h.y);
    lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
    lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  } else {
    let local_wi = vec3<f32>(dot(frame[0], wi), dot(frame[1], wi), cos_ni);
    ndf = bsdf_mf_aniso_d(lobe.alpha_x, lobe.alpha_y, local_h);
    lambda_wo = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wo);
    lambda_wi = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wi);
  }

  var jacobian = 0.25;
  if (do_refract) {
    let denom = coeff.cos_theta_t + cos_ho * inv_eta;
    jacobian = abs(cos_ho * coeff.cos_theta_t) / max(denom * denom, 1e-20);
  }
  let common_factor = (ndf / cos_no) * jacobian;
  let pdf = branch_pdf * common_factor / (1.0 + lambda_wo);
  let eval_val = lobe.weight * spec_weight * (energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi));
  return BsdfMfSample(wi, pdf, eval_val, false);
}
